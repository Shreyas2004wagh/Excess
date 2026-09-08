import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import type { MarketTicker } from '@excess/shared-types';

import type { ClerkGateway } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import type { MarketDataService } from '../market-data/market-data.service.js';
import { SessionService } from '../session/session.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { NotificationsService } from './notifications.service.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';

const clerkUserId = `user_notifications_${randomUUID()}`;
const identity = { clerkUserId, sessionId: 'session_notifications' };
const ticker: MarketTicker = {
  symbol: 'BTC-USD',
  price: '65000',
  bid: '64999.5',
  ask: '65000.5',
  change24h: '1.5',
  high24h: '66000',
  low24h: '64000',
  volume24h: '1200',
  status: 'LIVE',
  source: 'SIMULATED',
  updatedAt: new Date().toISOString(),
};

describe('Alert notification delivery', () => {
  const database = new DatabaseService();
  const clerk = {
    getUserProfile: jest.fn(async () => ({
      clerkUserId,
      email: 'trader+notifications@example.com',
      displayName: 'Notification Trader',
    })),
  } as unknown as ClerkGateway;
  const marketData = {
    getCurrentTicker: jest.fn(() => ticker),
  } as unknown as MarketDataService;
  const session = new SessionService(database, clerk);
  const alerts = new AlertsService(database, marketData);
  const notifications = new NotificationsService(database);
  const dispatcher = new OutboxDispatcherService(database);
  const competingDispatcher = new OutboxDispatcherService(database);

  beforeAll(async () => {
    await database.onModuleInit();
    await session.bootstrap(identity);
    await database.client.instrument.upsert({
      where: { symbol: 'BTC-USD' },
      create: {
        symbol: 'BTC-USD',
        baseCurrency: 'BTC',
        quoteCurrency: 'USD',
        pricePrecision: 2,
        quantityPrecision: 8,
        tickSize: '0.01',
        lotSize: '0.00000001',
        minimumQuantity: '0.00000001',
      },
      update: {},
    });
  });

  afterAll(async () => {
    const user = await database.client.user.findUnique({
      where: { clerkId: clerkUserId },
      include: { accounts: true, priceAlerts: true },
    });
    if (user) {
      const accountIds = user.accounts.map((account) => account.id);
      const alertIds = user.priceAlerts.map((alert) => alert.id);
      await database.client.$transaction([
        database.client.notification.deleteMany({ where: { userId: user.id } }),
        database.client.outboxEvent.deleteMany({
          where: {
            OR: [
              { aggregateId: { in: alertIds } },
              { aggregateId: `delivery-test:${user.id}` },
            ],
          },
        }),
        database.client.auditEvent.deleteMany({
          where: { actorUserId: user.id },
        }),
        database.client.priceAlert.deleteMany({ where: { userId: user.id } }),
        database.client.ledgerEntry.deleteMany({
          where: { accountId: { in: accountIds } },
        }),
        database.client.account.deleteMany({ where: { userId: user.id } }),
        database.client.user.delete({ where: { id: user.id } }),
      ]);
    }
    await database.onModuleDestroy();
  });

  it('delivers one in-app notification across competing workers', async () => {
    const created = await alerts.createAlert(identity, {
      symbol: 'BTC-USD',
      direction: 'ABOVE',
      targetPrice: '66000',
    });
    await alerts.processTicker({
      ...ticker,
      price: '66010',
      bid: '66009.5',
      ask: '66010.5',
      updatedAt: new Date().toISOString(),
    });

    await Promise.all([
      dispatcher.dispatchPending(),
      competingDispatcher.dispatchPending(),
    ]);
    await dispatcher.dispatchPending();

    const user = await database.client.user.findUniqueOrThrow({
      where: { clerkId: clerkUserId },
    });
    const [storedNotifications, delivery, deliveryAudits, listed] =
      await Promise.all([
        database.client.notification.findMany({ where: { userId: user.id } }),
        database.client.outboxEvent.findFirstOrThrow({
          where: { aggregateId: created.id },
        }),
        database.client.auditEvent.count({
          where: {
            actorUserId: user.id,
            action: 'IN_APP_NOTIFICATION_DELIVERED',
          },
        }),
        notifications.listNotifications(identity),
      ]);

    expect(storedNotifications).toHaveLength(1);
    expect(delivery).toMatchObject({ status: 'PUBLISHED', attempts: 1 });
    expect(deliveryAudits).toBe(1);
    expect(listed).toMatchObject({ unreadCount: 1 });
    expect(listed.items[0]).toMatchObject({
      title: 'BTC-USD price alert triggered',
      readAt: null,
    });

    const notificationId = listed.items[0]?.id;
    expect(notificationId).toBeDefined();
    if (!notificationId) return;
    const firstRead = await notifications.markRead(identity, notificationId);
    const repeatedRead = await notifications.markRead(identity, notificationId);
    expect(firstRead.readAt).toBeTruthy();
    expect(repeatedRead.readAt).toBe(firstRead.readAt);
    expect((await notifications.listNotifications(identity)).unreadCount).toBe(
      0,
    );
  });

  it('retries invalid events with backoff before marking them failed', async () => {
    const invalidEvent = await database.client.outboxEvent.create({
      data: {
        aggregateType: 'DELIVERY_TEST',
        aggregateId: `delivery-test:${
          (
            await database.client.user.findUniqueOrThrow({
              where: { clerkId: clerkUserId },
            })
          ).id
        }`,
        eventType: 'PRICE_ALERT_TRIGGERED',
        payload: {},
      },
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await database.client.outboxEvent.update({
        where: { id: invalidEvent.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await dispatcher.dispatchPending();
    }

    await expect(
      database.client.outboxEvent.findUniqueOrThrow({
        where: { id: invalidEvent.id },
      }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      attempts: 5,
      lastError: 'Price-alert event payload is invalid',
    });
  });
});
