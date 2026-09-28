import { randomUUID } from 'node:crypto';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';

import type { ClerkGateway } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import { SessionService } from '../session/session.service.js';
import type { HealthService } from '../health/health.service.js';
import { AdminService } from './admin.service.js';
import { parseAuditQuery } from './audit-query.js';

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

  it('paginates equal timestamps without omissions and projects exact metadata', async () => {
    const administrator = await database.client.user.findUniqueOrThrow({
      where: { clerkId: administratorClerkId },
    });
    const resourceId = randomUUID();
    const fixtureIds = Array.from({ length: 5 }, () => randomUUID())
      .sort()
      .reverse();
    await database.client.auditEvent.createMany({
      data: fixtureIds.map((id) => ({
        id,
        actorUserId: administrator.id,
        action: 'ORDER_FILLED',
        resourceType: 'ORDER',
        resourceId,
        createdAt: new Date('2024-06-02T12:00:00Z'),
        metadata: {
          quantity: '0.0000000001',
          fillPrice: '100.1234567891',
          token: 'never-export',
        },
        ipAddress: '127.0.0.1',
      })),
    });
    const query = {
      from: '2024-06-01',
      to: '2024-06-03',
      actorUserId: administrator.id,
      resourceId,
      limit: '2',
    };
    const first = await admin.getAuditEvents(
      administratorIdentity,
      parseAuditQuery(query),
    );
    const second = await admin.getAuditEvents(
      administratorIdentity,
      parseAuditQuery({
        ...query,
        asOf: first.filters.asOf,
        cursor: first.nextCursor!,
      }),
    );
    const third = await admin.getAuditEvents(
      administratorIdentity,
      parseAuditQuery({
        ...query,
        asOf: first.filters.asOf,
        cursor: second.nextCursor!,
      }),
    );
    expect(
      [...first.items, ...second.items, ...third.items].map(
        (event) => event.id,
      ),
    ).toEqual(fixtureIds);
    expect(third.nextCursor).toBeNull();
    expect(first.items[0]).toMatchObject({
      actorUserId: administrator.id,
      actorEmail: 'administrator@example.com',
      metadata: { quantity: '0.0000000001', fillPrice: '100.1234567891' },
    });
    expect(first.items[0]).not.toHaveProperty('ipAddress');
    expect(JSON.stringify(first)).not.toContain('never-export');
    const filtered = await admin.getAuditEvents(
      administratorIdentity,
      parseAuditQuery({ ...query, action: 'ORDER_CANCELLED' }),
    );
    expect(filtered.items).toEqual([]);
    await expect(
      admin.getAuditEvents(
        administratorIdentity,
        parseAuditQuery({
          ...query,
          action: 'ORDER_CANCELLED',
          cursor: first.nextCursor!,
          asOf: first.filters.asOf,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('honors the original cutoff and supports events without an associated user', async () => {
    const resourceId = randomUUID();
    const before = randomUUID(),
      after = randomUUID();
    const cutoff = new Date(Date.now() - 10_000);
    try {
      await database.client.auditEvent.createMany({
        data: [
          {
            id: before,
            action: 'SYSTEM_TEST',
            resourceType: 'ACCOUNT',
            resourceId,
            createdAt: new Date(cutoff.getTime() - 1000),
          },
          {
            id: after,
            action: 'SYSTEM_TEST',
            resourceType: 'ACCOUNT',
            resourceId,
            createdAt: new Date(cutoff.getTime() + 1000),
          },
        ],
      });
      const page = await admin.getAuditEvents(
        administratorIdentity,
        parseAuditQuery({
          resourceType: 'ACCOUNT',
          resourceId,
          asOf: cutoff.toISOString(),
        }),
      );
      expect(page.items.map((event) => event.id)).toEqual([before]);
      expect(page.items[0]).toMatchObject({
        actorUserId: null,
        actorEmail: null,
        metadata: null,
      });
    } finally {
      await database.client.auditEvent.deleteMany({
        where: { id: { in: [before, after] } },
      });
    }
  });

  it('rejects ordinary, suspended, and deleted administrators from the audit API', async () => {
    const query = parseAuditQuery({});
    await expect(
      admin.getAuditEvents(traderIdentity, query),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const user = await database.client.user.findUniqueOrThrow({
      where: { clerkId: administratorClerkId },
    });
    try {
      await database.client.user.update({
        where: { id: user.id },
        data: { status: 'SUSPENDED' },
      });
      await expect(
        admin.getAuditEvents(administratorIdentity, query),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await database.client.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE', identityDeletedAt: new Date() },
      });
      await expect(
        admin.getAuditEvents(administratorIdentity, query),
      ).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await database.client.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE', identityDeletedAt: null },
      });
    }
  });
});
