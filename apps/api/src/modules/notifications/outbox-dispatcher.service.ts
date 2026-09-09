import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { OutboxEvent } from '@excess/database';
import { z } from 'zod';

import { DatabaseService } from '../database/database.service.js';
import { MetricsService } from '../operational/metrics.service.js';
import { AlertEmailService } from './alert-email.service.js';

const DISPATCH_INTERVAL_MILLISECONDS = 1_000;
const CLAIM_LEASE_MILLISECONDS = 30_000;
const MAXIMUM_ATTEMPTS = 5;
const BATCH_SIZE = 25;

const priceAlertPayloadSchema = z.object({
  alertId: z.uuid(),
  userId: z.uuid(),
  symbol: z.string().min(1),
  direction: z.enum(['ABOVE', 'BELOW']),
  targetPrice: z.string(),
  triggeredPrice: z.string(),
});

export interface DispatchResult {
  claimed: number;
  published: number;
  failed: number;
}

@Injectable()
export class OutboxDispatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly email: AlertEmailService,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap() {
    void this.runScheduledDispatch();
    this.timer = setInterval(
      () => void this.runScheduledDispatch(),
      DISPATCH_INTERVAL_MILLISECONDS,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async dispatchPending(limit = BATCH_SIZE): Promise<DispatchResult> {
    const events = await this.claimEvents(limit);
    let published = 0;
    let failed = 0;

    for (const event of events) {
      try {
        await this.publishEvent(event);
        this.metrics.recordOutboxDispatch('published');
        published += 1;
      } catch (error) {
        failed += 1;
        await this.recordFailure(event, error);
        this.metrics.recordOutboxDispatch('failed');
      }
    }

    return { claimed: events.length, published, failed };
  }

  private async runScheduledDispatch() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.dispatchPending();
      if (result.published > 0 || result.failed > 0) {
        this.logger.log(
          `Outbox dispatch completed: ${result.published} published, ${result.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Outbox dispatch failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async claimEvents(limit: number) {
    const now = new Date();
    const staleBefore = new Date(Date.now() - CLAIM_LEASE_MILLISECONDS);
    const candidates = await this.database.client.outboxEvent.findMany({
      where: {
        eventType: 'PRICE_ALERT_TRIGGERED',
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          {
            status: 'PROCESSING',
            OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }],
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 100),
    });

    const claimed: OutboxEvent[] = [];
    for (const candidate of candidates) {
      const result = await this.database.client.outboxEvent.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attempts: candidate.attempts,
        },
        data: {
          status: 'PROCESSING',
          attempts: { increment: 1 },
          claimedAt: now,
        },
      });
      if (result.count === 1) {
        claimed.push(
          await this.database.client.outboxEvent.findUniqueOrThrow({
            where: { id: candidate.id },
          }),
        );
      }
    }
    return claimed;
  }

  private async publishEvent(event: OutboxEvent) {
    if (event.eventType !== 'PRICE_ALERT_TRIGGERED') {
      throw new Error(`Unsupported outbox event type: ${event.eventType}`);
    }
    const parsed = priceAlertPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      throw new Error('Price-alert event payload is invalid');
    }
    const payload = parsed.data;
    const title = `${payload.symbol} price alert triggered`;
    const message = `${payload.symbol} reached $${payload.triggeredPrice}, crossing ${payload.direction.toLowerCase()} your $${payload.targetPrice} target.`;

    const notification = await this.database.client.$transaction(
      async (transaction) => {
        const created = await transaction.notification.createMany({
          data: {
            userId: payload.userId,
            outboxEventId: event.id,
            type: event.eventType,
            title,
            message,
            metadata: payload,
            emailStatus: this.email.enabled ? 'PENDING' : 'DISABLED',
          },
          skipDuplicates: true,
        });
        if (created.count === 1) {
          await transaction.auditEvent.create({
            data: {
              actorUserId: payload.userId,
              action: 'IN_APP_NOTIFICATION_DELIVERED',
              resourceType: 'OUTBOX_EVENT',
              resourceId: event.id,
              metadata: { alertId: payload.alertId },
            },
          });
        }
        return transaction.notification.findUniqueOrThrow({
          where: { outboxEventId: event.id },
          include: { user: { select: { email: true } } },
        });
      },
    );

    if (this.email.enabled && notification.emailStatus !== 'SENT') {
      await this.database.client.notification.update({
        where: { id: notification.id },
        data: {
          emailStatus: 'PENDING',
          emailAttempts: { increment: 1 },
          emailLastError: null,
        },
      });

      try {
        const providerId = await this.email.send({
          to: notification.user.email,
          subject: title,
          message,
          outboxEventId: event.id,
        });
        await this.database.client.$transaction(async (transaction) => {
          const sent = await transaction.notification.updateMany({
            where: { id: notification.id, emailStatus: { not: 'SENT' } },
            data: {
              emailStatus: 'SENT',
              emailProviderId: providerId,
              emailLastError: null,
              emailSentAt: new Date(),
            },
          });
          if (sent.count === 1) {
            await transaction.auditEvent.create({
              data: {
                actorUserId: payload.userId,
                action: 'ALERT_EMAIL_DELIVERED',
                resourceType: 'OUTBOX_EVENT',
                resourceId: event.id,
                metadata: { alertId: payload.alertId, providerId },
              },
            });
          }
        });
        this.metrics.recordEmailAttempt('sent');
      } catch (error) {
        const emailError = (
          error instanceof Error ? error.message : 'unknown email error'
        ).slice(0, 1_000);
        await this.database.client.notification.update({
          where: { id: notification.id },
          data: { emailStatus: 'FAILED', emailLastError: emailError },
        });
        this.metrics.recordEmailAttempt('failed');
        throw error;
      }
    }

    const published = await this.database.client.outboxEvent.updateMany({
      where: { id: event.id, status: 'PROCESSING' },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        claimedAt: null,
        lastError: null,
      },
    });
    if (published.count !== 1) {
      throw new Error('Outbox claim was lost before publication');
    }
  }

  private async recordFailure(event: OutboxEvent, error: unknown) {
    const message = (
      error instanceof Error ? error.message : 'unknown error'
    ).slice(0, 1_000);
    const permanentlyFailed = event.attempts >= MAXIMUM_ATTEMPTS;
    const backoffMilliseconds = Math.min(
      60_000,
      1_000 * 2 ** Math.max(0, event.attempts - 1),
    );
    await this.database.client.outboxEvent.updateMany({
      where: { id: event.id, status: 'PROCESSING' },
      data: {
        status: permanentlyFailed ? 'FAILED' : 'PENDING',
        nextAttemptAt: new Date(Date.now() + backoffMilliseconds),
        claimedAt: null,
        lastError: message,
      },
    });
    this.logger.warn(
      `Could not publish outbox event ${event.id} on attempt ${event.attempts}: ${message}`,
    );
  }
}
