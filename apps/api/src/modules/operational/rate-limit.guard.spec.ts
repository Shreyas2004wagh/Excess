import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

import type { RedisService } from '../redis/redis.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';

function createContext(request: Partial<Request>, response: Partial<Response>) {
  return {
    getType: () => 'http',
    getHandler: () => createContext,
    getClass: () => RateLimitGuard,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function createGuard(options?: {
  maximumRequests?: number;
  skipped?: boolean;
  consumption?: { count: number; ttlSeconds: number } | null;
}) {
  const reflector = {
    getAllAndOverride: jest.fn(() => options?.skipped ?? false),
  };
  const redis = {
    consumeRateLimit: jest.fn(
      async (_key: string, _windowSeconds: number) =>
        options?.consumption ?? null,
    ),
  };
  const config = {
    getOrThrow: jest.fn((key: string) =>
      key === 'RATE_LIMIT_MAX' ? (options?.maximumRequests ?? 120) : 60,
    ),
  };
  const guard = new RateLimitGuard(
    reflector as unknown as Reflector,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
  );
  return { guard, redis };
}

function createHttpDoubles() {
  const request = {
    ip: '127.0.0.1',
    socket: {},
    identity: { clerkUserId: 'user_123', sessionId: 'session_123' },
  } as unknown as Request;
  const response = { setHeader: jest.fn() } as unknown as Response;
  return { request, response };
}

describe('RateLimitGuard', () => {
  it('allows requests within the shared limit and exposes quota headers', async () => {
    const { guard, redis } = createGuard({
      consumption: { count: 4, ttlSeconds: 25 },
    });
    const { request, response } = createHttpDoubles();

    await expect(
      guard.canActivate(createContext(request, response)),
    ).resolves.toBe(true);
    expect(redis.consumeRateLimit).toHaveBeenCalledWith(
      expect.stringContaining('user_123'),
      60,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-RateLimit-Remaining',
      116,
    );
  });

  it('rejects requests above the shared limit', async () => {
    const { guard } = createGuard({
      maximumRequests: 2,
      consumption: { count: 3, ttlSeconds: 12 },
    });
    const { request, response } = createHttpDoubles();

    await expect(
      guard.canActivate(createContext(request, response)),
    ).rejects.toMatchObject({ status: 429 });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', 12);
  });

  it('uses an in-memory window when Redis is unavailable', async () => {
    const { guard } = createGuard({ maximumRequests: 2 });
    const { request, response } = createHttpDoubles();
    const context = createContext(request, response);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('exempts explicitly skipped routes', async () => {
    const { guard, redis } = createGuard({ skipped: true });
    const { request, response } = createHttpDoubles();

    await expect(
      guard.canActivate(createContext(request, response)),
    ).resolves.toBe(true);
    expect(redis.consumeRateLimit).not.toHaveBeenCalled();
  });
});
