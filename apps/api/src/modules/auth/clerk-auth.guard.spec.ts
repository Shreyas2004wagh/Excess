import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { jest } from '@jest/globals';

import { ClerkAuthGuard } from './clerk-auth.guard.js';
import type { ClerkGateway } from './auth.types.js';

function createContext(request: Record<string, unknown>) {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function createRequest(authorization?: string) {
  return {
    headers: authorization ? { authorization } : {},
    get: () => 'localhost:4000',
    protocol: 'http',
    originalUrl: '/api/v1/accounts/demo',
    method: 'GET',
  };
}

describe('ClerkAuthGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  } as unknown as Reflector;

  it('allows explicitly public routes without authenticating', async () => {
    const clerk = { authenticate: jest.fn() } as unknown as ClerkGateway;
    const publicReflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const guard = new ClerkAuthGuard(publicReflector, clerk);

    await expect(
      guard.canActivate(createContext(createRequest())),
    ).resolves.toBe(true);
    expect(clerk.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'Bearer malformed'],
  ])('rejects a %s token', async (_label, authorization) => {
    const clerk = {
      authenticate: jest.fn(async () => ({ isAuthenticated: false })),
    } as unknown as ClerkGateway;
    const guard = new ClerkAuthGuard(reflector, clerk);

    await expect(
      guard.canActivate(createContext(createRequest(authorization))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired token verification error', async () => {
    const clerk = {
      authenticate: jest.fn(async () => {
        throw new Error('token-expired');
      }),
    } as unknown as ClerkGateway;
    const guard = new ClerkAuthGuard(reflector, clerk);

    await expect(
      guard.canActivate(createContext(createRequest('Bearer expired'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches the verified user and session identity', async () => {
    const clerk = {
      authenticate: jest.fn(async () => ({
        isAuthenticated: true,
        toAuth: () => ({ userId: 'user_valid', sessionId: 'session_valid' }),
      })),
    } as unknown as ClerkGateway;
    const guard = new ClerkAuthGuard(reflector, clerk);
    const request = createRequest('Bearer valid');

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request).toMatchObject({
      identity: { clerkUserId: 'user_valid', sessionId: 'session_valid' },
    });
  });
});
