import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';

import type { DatabaseService } from '../database/database.service.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

describe('MetricsController', () => {
  const count = jest.fn(async () => 0);
  const database = {
    client: {
      outboxEvent: { count },
      notification: { count },
    },
  } as unknown as DatabaseService;
  const config = {
    get: jest.fn(() => 'metrics-secret'),
  } as unknown as ConfigService;
  const response = {
    type: jest.fn(),
  } as unknown as Response;
  const controller = new MetricsController(
    database,
    new MetricsService(),
    config,
  );

  it('rejects scrapes without the independent metrics token', async () => {
    await expect(
      controller.getMetrics(undefined, response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns Prometheus text for an authorized scrape', async () => {
    await expect(
      controller.getMetrics('Bearer metrics-secret', response),
    ).resolves.toContain('excess_process_uptime_seconds');
    expect(response.type).toHaveBeenCalledWith(
      'text/plain; version=0.0.4; charset=utf-8',
    );
  });
});
