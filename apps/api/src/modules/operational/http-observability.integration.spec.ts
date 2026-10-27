import type { AddressInfo } from 'node:net';

import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { MetricsService } from './metrics.service.js';
import { requestContextMiddleware } from './request-context.middleware.js';
import { requestObservabilityMiddleware } from './request-observability.middleware.js';
import { SafeHttpExceptionFilter } from './safe-http-exception.filter.js';

@Injectable()
class DenyFixtureGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException({
      code: 'FIXTURE_DENIED',
      message: 'Access denied',
    });
  }
}

@Controller('fixture')
class FixtureController {
  @Get('failure/:id')
  fail() {
    throw new Error(
      'PRIVATE_SDK_ERROR postgres://user:PRIVATE_PASSWORD@host/db',
    );
  }

  @Get('denied')
  @UseGuards(DenyFixtureGuard)
  denied() {
    return { unexpected: true };
  }
}

describe('HTTP observability across the real Nest request lifecycle', () => {
  let app: INestApplication;
  let origin: string;
  let metrics: MetricsService;
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FixtureController],
      providers: [
        MetricsService,
        DenyFixtureGuard,
        { provide: APP_FILTER, useClass: SafeHttpExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    metrics = app.get(MetricsService);
    app.use(requestContextMiddleware);
    app.use(requestObservabilityMiddleware(metrics, logger));
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sanitizes unknown failures, records 500 once, and exposes a usable trace ID', async () => {
    const response = await fetch(
      `${origin}/api/v1/fixture/failure/PRIVATE_ID?token=PRIVATE_TOKEN`,
      { headers: { 'x-request-id': 'fixture-trace' } },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      requestId: 'fixture-trace',
    });
    expect(response.headers.get('x-request-id')).toBe('fixture-trace');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.error.mock.calls[0]?.[0] as string)).toMatchObject(
      {
        event: 'http.request.failed',
        statusCode: 500,
        route: '/api/v1/fixture/failure/:id',
      },
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('PRIVATE_');
  });

  it('counts guard rejection while preserving the deliberate error code', async () => {
    const response = await fetch(`${origin}/api/v1/fixture/denied`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: 'FIXTURE_DENIED',
      message: 'Access denied',
    });
    const output = metrics.render({
      outbox: { PENDING: 0, PROCESSING: 0, PUBLISHED: 0, FAILED: 0 },
      email: { DISABLED: 0, PENDING: 0, SENT: 0, FAILED: 0 },
    });
    expect(output).toContain(
      'excess_http_requests_total{method="GET",status="403"} 1',
    );
    expect(output).toContain(
      'excess_http_requests_total{method="GET",status="500"} 1',
    );
  });

  it('never logs arbitrary unmatched paths or query parameters', async () => {
    const response = await fetch(
      `${origin}/api/v1/PRIVATE_UNKNOWN_PATH?email=PRIVATE_EMAIL`,
    );
    expect(response.status).toBe(404);
    await response.text();
    const last = logger.warn.mock.calls.at(-1)?.[0] as string;
    expect(JSON.parse(last).route).toBe('unmatched');
    expect(last).not.toContain('PRIVATE_');
  });
});
