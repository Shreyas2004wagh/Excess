import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { jest } from '@jest/globals';
import type { MarketTicker } from '@excess/shared-types';

import type { ClerkGateway } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import type { MarketDataService } from '../market-data/market-data.service.js';
import { SessionService } from '../session/session.service.js';
import { AlertsService } from './alerts.service.js';

const clerkUserId = `user_alerts_${randomUUID()}`;
const identity = { clerkUserId, sessionId: 'session_alerts' };
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
const ethTicker: MarketTicker = {
  ...ticker,
  symbol: 'ETH-USD',
  price: '3500',
  bid: '3499.95',
  ask: '3500.05',
  high24h: '3600',
  low24h: '3400',
};

describe('Milestone 6 price alerts', () => {
  const database = new DatabaseService();
  const clerk = {
    getUserProfile: jest.fn(async () => ({
      clerkUserId,
      email: 'trader+alerts@example.com',
      displayName: 'Alert Trader',
    })),
  } as unknown as ClerkGateway;
  const marketData = {
    getCurrentTicker: jest.fn((symbol = 'BTC-USD') =>
      symbol === 'ETH-USD' ? ethTicker : ticker,
    ),
  } as unknown as MarketDataService;
  const session = new SessionService(database, clerk);
  const alerts = new AlertsService(database, marketData);
  const competingWorker = new AlertsService(database, marketData);

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
    await database.client.instrument.upsert({
      where: { symbol: 'ETH-USD' },
      create: {
        symbol: 'ETH-USD',
        baseCurrency: 'ETH',
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
        database.client.outboxEvent.deleteMany({
          where: {
            aggregateType: 'PRICE_ALERT',
            aggregateId: { in: alertIds },
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

  it('requires an alert target beyond the current market', async () => {
    await expect(
      alerts.createAlert(identity, {
        symbol: 'BTC-USD',
        direction: 'ABOVE',
        targetPrice: '64000',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates, lists, and cancels an active alert', async () => {
    const created = await alerts.createAlert(identity, {
      symbol: 'BTC-USD',
      direction: 'BELOW',
      targetPrice: '64000',
    });
    expect(created).toMatchObject({
      status: 'ACTIVE',
      deliveryStatus: null,
      targetPrice: '64000',
    });
    expect((await alerts.listAlerts(identity)).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
    );
    expect((await alerts.cancelAlert(identity, created.id)).status).toBe(
      'CANCELLED',
    );
  });

  it('triggers once across competing workers and queues delivery', async () => {
    const created = await alerts.createAlert(identity, {
      symbol: 'BTC-USD',
      direction: 'ABOVE',
      targetPrice: '66000',
    });
    const crossingTicker = {
      ...ticker,
      price: '66010',
      bid: '66009.5',
      ask: '66010.5',
      updatedAt: new Date().toISOString(),
    };

    await Promise.all([
      alerts.processTicker(crossingTicker),
      competingWorker.processTicker(crossingTicker),
    ]);
    await alerts.processTicker(crossingTicker);

    const [stored, outboxCount, auditCount, listed] = await Promise.all([
      database.client.priceAlert.findUniqueOrThrow({
        where: { id: created.id },
      }),
      database.client.outboxEvent.count({
        where: {
          aggregateType: 'PRICE_ALERT',
          aggregateId: created.id,
          eventType: 'PRICE_ALERT_TRIGGERED',
        },
      }),
      database.client.auditEvent.count({
        where: {
          actorUserId: (
            await database.client.user.findUniqueOrThrow({
              where: { clerkId: clerkUserId },
            })
          ).id,
          action: 'PRICE_ALERT_TRIGGERED',
          resourceId: created.id,
        },
      }),
      alerts.listAlerts(identity),
    ]);

    expect(stored).toMatchObject({ status: 'TRIGGERED' });
    expect(stored.triggeredPrice?.toString()).toBe('66010');
    expect(outboxCount).toBe(1);
    expect(auditCount).toBe(1);
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          status: 'TRIGGERED',
          deliveryStatus: 'PENDING',
          triggeredPrice: '66010',
        }),
      ]),
    );
  });

  it('creates and triggers an ETH-USD alert from the ETH stream only', async () => {
    const created = await alerts.createAlert(identity, {
      symbol: 'ETH-USD',
      direction: 'ABOVE',
      targetPrice: '3550',
    });

    await alerts.processTicker({ ...ticker, price: '70000' });
    expect(
      await database.client.priceAlert.findUniqueOrThrow({
        where: { id: created.id },
      }),
    ).toMatchObject({ status: 'ACTIVE' });

    await alerts.processTicker({
      ...ethTicker,
      price: '3551',
      bid: '3550.95',
      ask: '3551.05',
    });
    expect(
      await database.client.priceAlert.findUniqueOrThrow({
        where: { id: created.id },
      }),
    ).toMatchObject({ status: 'TRIGGERED' });
  });
});
