import { randomUUID } from 'node:crypto';

import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';

import type { ClerkGateway } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import { SessionService } from '../session/session.service.js';
import type { HealthService } from '../health/health.service.js';
import { AdminService } from './admin.service.js';

const administratorClerkId = `user_admin_${randomUUID()}`;
const traderClerkId = `user_trader_${randomUUID()}`;
const administratorIdentity = {
  clerkUserId: administratorClerkId,
  sessionId: 'session_admin',
};
const traderIdentity = {
  clerkUserId: traderClerkId,
  sessionId: 'session_trader',
};

describe('Administration', () => {
  const database = new DatabaseService();
  const administratorClerk = {
    getUserProfile: jest.fn(async () => ({
      clerkUserId: administratorClerkId,
      email: 'administrator@example.com',
      displayName: 'Excess Administrator',
    })),
  } as unknown as ClerkGateway;
  const traderClerk = {
    getUserProfile: jest.fn(async () => ({
      clerkUserId: traderClerkId,
      email: 'ordinary-trader@example.com',
      displayName: 'Ordinary Trader',
    })),
  } as unknown as ClerkGateway;
  const config = {
    get: jest.fn((key: string) =>
      key === 'ADMIN_EMAILS' ? 'administrator@example.com' : undefined,
    ),
  } as unknown as ConfigService;
  const administratorSession = new SessionService(
    database,
    administratorClerk,
    config,
  );
  const traderSession = new SessionService(database, traderClerk);
  const health = {
    getReadiness: jest.fn(async () => ({
      service: 'excess-api' as const,
      status: 'ready' as const,
      checks: {
        database: 'up' as const,
        redis: 'up' as const,
        marketData: 'up' as const,
      },
      timestamp: new Date().toISOString(),
    })),
  } as unknown as HealthService;
  const admin = new AdminService(database, health);

  beforeAll(async () => {
    await database.onModuleInit();
    await Promise.all([
      administratorSession.bootstrap(administratorIdentity),
      traderSession.bootstrap(traderIdentity),
    ]);
  });

  afterAll(async () => {
    const users = await database.client.user.findMany({
      where: { clerkId: { in: [administratorClerkId, traderClerkId] } },
      include: { accounts: true },
    });
    const userIds = users.map((user) => user.id);
    const accountIds = users.flatMap((user) =>
      user.accounts.map((account) => account.id),
    );
    await database.client.$transaction([
      database.client.outboxEvent.deleteMany({
        where: { aggregateId: { in: userIds.map((id) => `admin-test:${id}`) } },
      }),
      database.client.auditEvent.deleteMany({
        where: { actorUserId: { in: userIds } },
      }),
      database.client.ledgerEntry.deleteMany({
        where: { accountId: { in: accountIds } },
      }),
      database.client.account.deleteMany({
        where: { userId: { in: userIds } },
      }),
      database.client.user.deleteMany({ where: { id: { in: userIds } } }),
    ]);
    await database.onModuleDestroy();
  });

  it('promotes only allowlisted verified emails and protects admin data', async () => {
    const [administrator, trader] = await Promise.all([
      database.client.user.findUniqueOrThrow({
        where: { clerkId: administratorClerkId },
      }),
      database.client.user.findUniqueOrThrow({
        where: { clerkId: traderClerkId },
      }),
    ]);
    expect(administrator.role).toBe('ADMIN');
    expect(trader.role).toBe('TRADER');
    await expect(admin.getOverview(traderIdentity)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      admin.getOverview(administratorIdentity),
    ).resolves.toMatchObject({
      totals: { users: expect.any(Number), demoAccounts: expect.any(Number) },
      deliveries: { failed: expect.any(Number) },
      system: { status: 'ready' },
    });
  });

  it('allows an administrator to retry a failed delivery with an audit trail', async () => {
    const administrator = await database.client.user.findUniqueOrThrow({
      where: { clerkId: administratorClerkId },
    });
    const event = await database.client.outboxEvent.create({
      data: {
        aggregateType: 'ADMIN_TEST',
        aggregateId: `admin-test:${administrator.id}`,
        eventType: 'ADMIN_TEST_EVENT',
        payload: {},
        status: 'FAILED',
        attempts: 5,
        lastError: 'test failure',
      },
    });

    const results = await Promise.allSettled([
      admin.retryDelivery(administratorIdentity, event.id),
      admin.retryDelivery(administratorIdentity, event.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(
      database.client.outboxEvent.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).resolves.toMatchObject({
      status: 'PENDING',
      attempts: 0,
      lastError: null,
    });
    expect(
      await database.client.auditEvent.count({
        where: {
          actorUserId: administrator.id,
          action: 'OUTBOX_DELIVERY_RETRIED',
          resourceId: event.id,
        },
      }),
    ).toBe(1);
  });
});
