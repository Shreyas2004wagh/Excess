import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole, UserStatus, type Prisma } from '@excess/database';
import type {
  AdminAuditPage,
  AdminDeliverySummary,
  AdminOverviewResponse,
} from '@excess/shared-types';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import { HealthService } from '../health/health.service.js';
import type { AuditQuery } from './audit-query.js';
import { auditMetadata } from './audit-metadata.js';

type DeliveryWithNotification = Prisma.OutboxEventGetPayload<{
  include: { notification: true };
}>;

function serializeDelivery(
  event: DeliveryWithNotification,
): AdminDeliverySummary {
  return {
    id: event.id,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    status: event.status,
    attempts: event.attempts,
    lastError: event.lastError,
    emailStatus: event.notification?.emailStatus ?? null,
    emailAttempts: event.notification?.emailAttempts ?? 0,
    emailLastError: event.notification?.emailLastError ?? null,
    emailSentAt: event.notification?.emailSentAt?.toISOString() ?? null,
    createdAt: event.createdAt.toISOString(),
    publishedAt: event.publishedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly health: HealthService,
  ) {}

  async getOverview(identity: ClerkIdentity): Promise<AdminOverviewResponse> {
    await this.requireAdministrator(identity);
    const [
      users,
      activeUsers,
      demoAccounts,
      openOrders,
      openPositions,
      activePriceAlerts,
      unreadNotifications,
      pending,
      processing,
      published,
      failed,
      emailDisabled,
      emailPending,
      emailSent,
      emailFailed,
      recentDeliveries,
      recentUsers,
      recentAuditEvents,
      system,
    ] = await Promise.all([
      this.database.client.user.count(),
      this.database.client.user.count({ where: { status: 'ACTIVE' } }),
      this.database.client.account.count({ where: { type: 'DEMO' } }),
      this.database.client.order.count({
        where: {
          status: { in: ['PENDING', 'ACCEPTED', 'PARTIALLY_FILLED'] },
        },
      }),
      this.database.client.position.count({
        where: { signedQuantity: { not: '0' } },
      }),
      this.database.client.priceAlert.count({ where: { status: 'ACTIVE' } }),
      this.database.client.notification.count({ where: { readAt: null } }),
      this.database.client.outboxEvent.count({
        where: { aggregateType: 'PRICE_ALERT', status: 'PENDING' },
      }),
      this.database.client.outboxEvent.count({
        where: { aggregateType: 'PRICE_ALERT', status: 'PROCESSING' },
      }),
      this.database.client.outboxEvent.count({
        where: { aggregateType: 'PRICE_ALERT', status: 'PUBLISHED' },
      }),
      this.database.client.outboxEvent.count({
        where: { aggregateType: 'PRICE_ALERT', status: 'FAILED' },
      }),
      this.database.client.notification.count({
        where: { emailStatus: 'DISABLED' },
      }),
      this.database.client.notification.count({
        where: { emailStatus: 'PENDING' },
      }),
      this.database.client.notification.count({
        where: { emailStatus: 'SENT' },
      }),
      this.database.client.notification.count({
        where: { emailStatus: 'FAILED' },
      }),
      this.database.client.outboxEvent.findMany({
        where: { aggregateType: 'PRICE_ALERT' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        include: { notification: true },
      }),
      this.database.client.user.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          role: true,
          createdAt: true,
        },
      }),
      this.database.client.auditEvent.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        include: { actor: { select: { email: true } } },
      }),
      this.health.getReadiness(),
    ]);

    return {
      system,
      totals: {
        users,
        activeUsers,
        demoAccounts,
        openOrders,
        openPositions,
        activePriceAlerts,
        unreadNotifications,
      },
      deliveries: { pending, processing, published, failed },
      emailDeliveries: {
        disabled: emailDisabled,
        pending: emailPending,
        sent: emailSent,
        failed: emailFailed,
      },
      recentDeliveries: recentDeliveries.map(serializeDelivery),
      recentUsers: recentUsers.map((user) => ({
        ...user,
        createdAt: user.createdAt.toISOString(),
      })),
      recentAuditEvents: recentAuditEvents.map((event) => ({
        id: event.id,
        actorEmail: event.actor?.email ?? null,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        createdAt: event.createdAt.toISOString(),
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  async retryDelivery(identity: ClerkIdentity, eventId: string) {
    const administrator = await this.requireAdministrator(identity);
    const event = await this.database.client.outboxEvent.findUnique({
      where: { id: eventId },
    });
    if (!event) {
      throw new NotFoundException({
        code: 'OUTBOX_EVENT_NOT_FOUND',
        message: 'The delivery event could not be found',
      });
    }
    if (event.status !== 'FAILED') {
      throw new ConflictException({
        code: 'OUTBOX_EVENT_NOT_RETRYABLE',
        message: 'Only failed delivery events can be retried',
      });
    }

    const retried = await this.database.client.$transaction(
      async (transaction) => {
        const updated = await transaction.outboxEvent.updateMany({
          where: { id: event.id, status: 'FAILED' },
          data: {
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: new Date(),
            claimedAt: null,
            lastError: null,
          },
        });
        if (updated.count !== 1) {
          throw new ConflictException({
            code: 'OUTBOX_EVENT_NOT_RETRYABLE',
            message: 'The delivery event has already been requeued',
          });
        }
        await transaction.auditEvent.create({
          data: {
            actorUserId: administrator.id,
            action: 'OUTBOX_DELIVERY_RETRIED',
            resourceType: 'OUTBOX_EVENT',
            resourceId: event.id,
          },
        });
        return transaction.outboxEvent.findUniqueOrThrow({
          where: { id: event.id },
          include: { notification: true },
        });
      },
    );
    return serializeDelivery(retried);
  }

  async getAuditEvents(
    identity: ClerkIdentity,
    query: AuditQuery,
  ): Promise<AdminAuditPage> {
    return this.database.client.$transaction(
      async (tx) => {
        await this.requireAdministrator(identity, tx);
        const where: Prisma.AuditEventWhereInput = {
          createdAt: {
            gte: query.start,
            lt: query.endExclusive,
            lte: query.cutoff,
          },
          ...(query.filters.action ? { action: query.filters.action } : {}),
          ...(query.filters.actorUserId
            ? { actorUserId: query.filters.actorUserId }
            : {}),
          ...(query.filters.resourceType
            ? { resourceType: query.filters.resourceType }
            : {}),
          ...(query.filters.resourceId
            ? { resourceId: query.filters.resourceId }
            : {}),
        };
        let boundary: Prisma.AuditEventWhereInput = {};
        if (query.cursor) {
          const cursor = await tx.auditEvent.findFirst({
            where: { ...where, id: query.cursor },
            select: { id: true, createdAt: true },
          });
          if (!cursor)
            throw new BadRequestException({
              code: 'INVALID_AUDIT_CURSOR',
              message: 'The cursor does not belong to these audit filters.',
            });
          boundary = {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          };
        }
        const events = await tx.auditEvent.findMany({
          where: { AND: [where, boundary] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
          include: { actor: { select: { email: true } } },
        });
        const page = events.slice(0, query.limit);
        return {
          filters: query.filters,
          nextCursor: events.length > query.limit ? page.at(-1)!.id : null,
          items: page.map((event) => ({
            id: event.id,
            action: event.action,
            actorUserId: event.actorUserId,
            actorEmail: event.actor?.email ?? null,
            resourceType: event.resourceType,
            resourceId: event.resourceId,
            createdAt: event.createdAt.toISOString(),
            metadata: auditMetadata(event.metadata),
          })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private async requireAdministrator(
    identity: ClerkIdentity,
    client: Prisma.TransactionClient = this.database.client,
  ) {
    const user = await client.user.findUnique({
      where: { clerkId: identity.clerkUserId },
    });
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      user.identityDeletedAt ||
      user.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException({
        code: 'ADMIN_REQUIRED',
        message: 'Administrator access is required',
      });
    }
    return user;
  }
}
