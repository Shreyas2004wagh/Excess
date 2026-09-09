import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  Headers,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { Public } from '../auth/public.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { MetricsService } from './metrics.service.js';
import { SkipRateLimit } from './skip-rate-limit.decorator.js';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Public()
  @SkipRateLimit()
  async getMetrics(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.authorize(authorization);
    const [
      pending,
      processing,
      published,
      failed,
      disabled,
      emailPending,
      sent,
      emailFailed,
    ] = await Promise.all([
      this.countOutbox('PENDING'),
      this.countOutbox('PROCESSING'),
      this.countOutbox('PUBLISHED'),
      this.countOutbox('FAILED'),
      this.countEmail('DISABLED'),
      this.countEmail('PENDING'),
      this.countEmail('SENT'),
      this.countEmail('FAILED'),
    ]);

    response.type('text/plain; version=0.0.4; charset=utf-8');
    return this.metrics.render({
      outbox: {
        PENDING: pending,
        PROCESSING: processing,
        PUBLISHED: published,
        FAILED: failed,
      },
      email: {
        DISABLED: disabled,
        PENDING: emailPending,
        SENT: sent,
        FAILED: emailFailed,
      },
    });
  }

  private authorize(authorization: string | undefined) {
    const expected = this.config.get<string>('METRICS_BEARER_TOKEN');
    if (!expected) return;
    const supplied = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (
      expectedBytes.length !== suppliedBytes.length ||
      !timingSafeEqual(expectedBytes, suppliedBytes)
    ) {
      throw new UnauthorizedException({
        code: 'METRICS_AUTH_REQUIRED',
        message: 'A valid metrics bearer token is required',
      });
    }
  }

  private countOutbox(
    status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED',
  ) {
    return this.database.client.outboxEvent.count({
      where: { aggregateType: 'PRICE_ALERT', status },
    });
  }

  private countEmail(status: 'DISABLED' | 'PENDING' | 'SENT' | 'FAILED') {
    return this.database.client.notification.count({
      where: { emailStatus: status },
    });
  }
}
