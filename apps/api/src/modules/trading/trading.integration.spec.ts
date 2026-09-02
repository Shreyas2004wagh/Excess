import { randomUUID } from 'node:crypto';

import { UnprocessableEntityException } from '@nestjs/common';
import { jest } from '@jest/globals';
import type { MarketTicker } from '@excess/shared-types';

import type { ClerkGateway } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import type { MarketDataService } from '../market-data/market-data.service.js';
import { SessionService } from '../session/session.service.js';
import { TradingService } from './trading.service.js';

const clerkUserId = `user_trading_${randomUUID()}`;
const identity = { clerkUserId, sessionId: 'session_trading' };
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

describe('Milestone 3 market-order execution', () => {
  const database = new DatabaseService();
  const clerk = {
    getUserProfile: jest.fn(async () => ({
      clerkUserId,
      email: 'trader+market@example.com',
      displayName: 'Market Trader',
    })),
  } as unknown as ClerkGateway;
  const marketData = {
    getCurrentTicker: jest.fn(() => ticker),
  } as unknown as MarketDataService;
  const session = new SessionService(database, clerk);
  const trading = new TradingService(database, marketData);

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
    });
    if (user) {
      const accounts = await database.client.account.findMany({
        where: { userId: user.id },
        select: { id: true },
      });
      const accountIds = accounts.map((account) => account.id);
      const orders = await database.client.order.findMany({
        where: { accountId: { in: accountIds } },
        select: { id: true },
      });
      await database.client.$transaction([
        database.client.outboxEvent.deleteMany({
          where: { aggregateId: { in: orders.map((order) => order.id) } },
        }),
        database.client.auditEvent.deleteMany({
          where: { actorUserId: user.id },
        }),
        database.client.ledgerEntry.deleteMany({
          where: { accountId: { in: accountIds } },
        }),
        database.client.trade.deleteMany({
          where: { accountId: { in: accountIds } },
        }),
        database.client.order.deleteMany({
          where: { accountId: { in: accountIds } },
        }),
        database.client.position.deleteMany({
          where: { accountId: { in: accountIds } },
        }),
        database.client.account.deleteMany({ where: { userId: user.id } }),
        database.client.user.delete({ where: { id: user.id } }),
      ]);
    }
    await database.onModuleDestroy();
  });

  it('fills a concurrent duplicate market order exactly once', async () => {
    const clientOrderId = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        trading.placeMarketOrder(identity, {
          clientOrderId,
          symbol: 'BTC-USD',
          side: 'BUY',
          type: 'MARKET',
          quantity: '0.1',
        }),
      ),
    );

    expect(new Set(responses.map((response) => response.order.id)).size).toBe(
      1,
    );
    expect(responses[0]).toMatchObject({
      order: {
        clientOrderId,
        status: 'FILLED',
        executedQuantity: '0.1',
        averageFillPrice: '65000.5',
      },
      trade: { price: '65000.5', quantity: '0.1', fee: '0' },
      portfolio: {
        account: { balance: '10000' },
        positions: [
          {
            signedQuantity: '0.1',
            averageEntryPrice: '65000.5',
          },
        ],
      },
    });

    const user = await database.client.user.findUniqueOrThrow({
      where: { clerkId: clerkUserId },
      include: { accounts: true },
    });
    const accountId = user.accounts[0]!.id;
    expect(
      await database.client.order.count({
        where: { accountId, clientOrderId },
      }),
    ).toBe(1);
    expect(await database.client.trade.count({ where: { accountId } })).toBe(1);
  });

  it('rejects an order above the available 1× buying power', async () => {
    await expect(
      trading.placeMarketOrder(identity, {
        clientOrderId: randomUUID(),
        symbol: 'BTC-USD',
        side: 'BUY',
        type: 'MARKET',
        quantity: '0.1',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('realizes P/L into the balance and ledger when closing', async () => {
    ticker.price = '66000';
    ticker.bid = '66000';
    ticker.ask = '66001';
    const response = await trading.placeMarketOrder(identity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.1',
    });

    expect(response.portfolio).toMatchObject({
      account: { balance: '10099.95' },
      equity: '10099.95',
      unrealizedPnl: '0',
      positions: [],
    });
    const ledger = await database.client.ledgerEntry.findFirstOrThrow({
      where: {
        accountId: response.portfolio.account.id,
        type: 'REALIZED_PNL',
      },
    });
    expect(ledger.amount.toString()).toBe('99.95');
    expect(ledger.balanceAfter.toString()).toBe('10099.95');
  });

  it('returns live unrealized P/L for an open short position', async () => {
    await trading.placeMarketOrder(identity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.05',
    });
    ticker.price = '65000';
    ticker.bid = '64999.5';
    ticker.ask = '65000.5';

    const portfolio = await trading.getPortfolio(identity);
    expect(portfolio).toMatchObject({
      equity: '10149.95',
      unrealizedPnl: '50',
      positions: [
        {
          signedQuantity: '-0.05',
          averageEntryPrice: '66000',
          markPrice: '65000',
          unrealizedPnl: '50',
        },
      ],
    });
  });
});
