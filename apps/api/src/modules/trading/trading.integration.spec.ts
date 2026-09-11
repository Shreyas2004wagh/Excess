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
const ethTicker: MarketTicker = {
  ...ticker,
  symbol: 'ETH-USD',
  price: '3500',
  bid: '3499.95',
  ask: '3500.05',
  change24h: '-0.5',
  high24h: '3600',
  low24h: '3400',
  volume24h: '85000',
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
    getCurrentTicker: jest.fn((symbol = 'BTC-USD') =>
      symbol === 'ETH-USD' ? ethTicker : ticker,
    ),
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

  it('opens ETH-USD independently and marks both instruments correctly', async () => {
    const response = await trading.placeMarketOrder(identity, {
      clientOrderId: randomUUID(),
      symbol: 'ETH-USD',
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
      leverage: 2,
    });

    expect(response.trade).toMatchObject({
      symbol: 'ETH-USD',
      price: '3500.05',
      quantity: '1',
    });
    expect(response.portfolio.positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'BTC-USD', markPrice: '65000' }),
        expect.objectContaining({
          symbol: 'ETH-USD',
          signedQuantity: '1',
          markPrice: '3500',
          leverage: 2,
        }),
      ]),
    );
  });
});

describe('Milestone 4 pending and protective orders', () => {
  const pendingClerkUserId = `user_pending_${randomUUID()}`;
  const pendingIdentity = {
    clerkUserId: pendingClerkUserId,
    sessionId: 'session_pending',
  };
  const pendingTicker: MarketTicker = {
    ...ticker,
    price: '65000',
    bid: '64999.5',
    ask: '65000.5',
  };
  const database = new DatabaseService();
  const clerk = {
    getUserProfile: jest.fn(async () => ({
      clerkUserId: pendingClerkUserId,
      email: 'trader+pending@example.com',
      displayName: 'Pending Trader',
    })),
  } as unknown as ClerkGateway;
  const marketData = {
    getCurrentTicker: jest.fn(() => pendingTicker),
  } as unknown as MarketDataService;
  const session = new SessionService(database, clerk);
  const trading = new TradingService(database, marketData);

  beforeAll(async () => {
    await database.onModuleInit();
    await session.bootstrap(pendingIdentity);
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
      where: { clerkId: pendingClerkUserId },
      include: { accounts: true },
    });
    if (user) {
      const accountIds = user.accounts.map((account) => account.id);
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

  it('accepts and cancels a resting limit order', async () => {
    const placed = await trading.placeOrder(pendingIdentity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '0.05',
      limitPrice: '64000',
    });

    expect(placed).toMatchObject({
      order: {
        status: 'ACCEPTED',
        type: 'LIMIT',
        requestedPrice: '64000',
      },
      trade: null,
    });
    expect((await trading.getOpenOrders(pendingIdentity)).items).toHaveLength(
      1,
    );

    const cancelled = await trading.cancelOrder(
      pendingIdentity,
      placed.order.id,
    );
    expect(cancelled.status).toBe('CANCELLED');
    expect((await trading.getOpenOrders(pendingIdentity)).items).toHaveLength(
      0,
    );
  });

  it('fills a buy stop once the live ask crosses its trigger', async () => {
    const placed = await trading.placeOrder(pendingIdentity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'STOP',
      quantity: '0.05',
      stopPrice: '65100',
    });
    pendingTicker.price = '65110';
    pendingTicker.bid = '65109.5';
    pendingTicker.ask = '65110';
    await trading.processPendingOrders(pendingTicker);

    const order = await database.client.order.findUniqueOrThrow({
      where: { id: placed.order.id },
      include: { trades: true },
    });
    expect(order.status).toBe('FILLED');
    expect(order.triggeredAt).toBeInstanceOf(Date);
    expect(order.trades).toHaveLength(1);
    expect(order.trades[0]?.price.toString()).toBe('65110');
    expect(
      (await trading.getPortfolio(pendingIdentity)).positions[0],
    ).toMatchObject({ signedQuantity: '0.05', averageEntryPrice: '65110' });
  });

  it('creates OCO protection and cancels the sibling after take-profit', async () => {
    await trading.placeMarketOrder(pendingIdentity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side: 'SELL',
      type: 'MARKET',
      quantity: '0.05',
    });
    pendingTicker.price = '65000';
    pendingTicker.bid = '64999.5';
    pendingTicker.ask = '65000.5';
    const entry = await trading.placeOrder(pendingIdentity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'MARKET',
      quantity: '0.05',
      stopLossPrice: '64000',
      takeProfitPrice: '66000',
    });

    expect(entry.relatedOrders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'STOP_LOSS', reduceOnly: true }),
        expect.objectContaining({ purpose: 'TAKE_PROFIT', reduceOnly: true }),
      ]),
    );
    pendingTicker.price = '66010';
    pendingTicker.bid = '66010';
    pendingTicker.ask = '66010.5';
    await trading.processPendingOrders(pendingTicker);

    const protections = await database.client.order.findMany({
      where: { parentOrderId: entry.order.id },
      orderBy: { purpose: 'asc' },
    });
    expect(protections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'STOP_LOSS', status: 'CANCELLED' }),
        expect.objectContaining({ purpose: 'TAKE_PROFIT', status: 'FILLED' }),
      ]),
    );
    expect((await trading.getPortfolio(pendingIdentity)).positions).toEqual([]);
    expect(
      await database.client.ledgerEntry.count({
        where: {
          accountId: entry.portfolio.account.id,
          type: 'REALIZED_PNL',
        },
      }),
    ).toBe(2);
  });

  it('rejects a triggered entry that no longer has enough buying power', async () => {
    pendingTicker.price = '66000';
    pendingTicker.bid = '65999.5';
    pendingTicker.ask = '66000.5';
    const placed = await trading.placeOrder(pendingIdentity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '1',
      limitPrice: '65000',
    });

    pendingTicker.price = '64999';
    pendingTicker.bid = '64998.5';
    pendingTicker.ask = '64999.5';
    await trading.processPendingOrders(pendingTicker);

    const order = await database.client.order.findUniqueOrThrow({
      where: { id: placed.order.id },
    });
    expect(order).toMatchObject({
      status: 'REJECTED',
      rejectionCode: 'INSUFFICIENT_BUYING_POWER',
    });
    expect(order.triggeredAt).toBeInstanceOf(Date);
  });
});

describe('Milestone 5 margin and liquidation', () => {
  const riskClerkUserId = `user_risk_${randomUUID()}`;
  const riskIdentity = {
    clerkUserId: riskClerkUserId,
    sessionId: 'session_risk',
  };
  const riskTicker: MarketTicker = {
    ...ticker,
    price: '65000',
    bid: '64999.5',
    ask: '65000.5',
  };
  const database = new DatabaseService();
  const clerk = {
    getUserProfile: jest.fn(async () => ({
      clerkUserId: riskClerkUserId,
      email: 'trader+risk@example.com',
      displayName: 'Risk Trader',
    })),
  } as unknown as ClerkGateway;
  const marketData = {
    getCurrentTicker: jest.fn(() => riskTicker),
  } as unknown as MarketDataService;
  const session = new SessionService(database, clerk);
  const trading = new TradingService(database, marketData);

  beforeAll(async () => {
    await database.onModuleInit();
    await session.bootstrap(riskIdentity);
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
      where: { clerkId: riskClerkUserId },
      include: { accounts: true },
    });
    if (user) {
      const accountIds = user.accounts.map((account) => account.id);
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

  it('calculates leveraged margin and rejects mixed leverage', async () => {
    const entry = await trading.placeOrder(riskIdentity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
    });

    expect(entry.order.leverage).toBe(10);
    expect(entry.portfolio).toMatchObject({
      equity: '9999.5',
      unrealizedPnl: '-0.5',
      usedMargin: '6500',
      freeMargin: '3499.5',
      riskState: 'HEALTHY',
      positions: [{ leverage: 10, usedMargin: '6500' }],
    });
    expect(Number(entry.portfolio.marginLevel)).toBeCloseTo(153.83846, 4);

    await expect(
      trading.placeOrder(riskIdentity, {
        clientOrderId: randomUUID(),
        symbol: 'BTC-USD',
        side: 'BUY',
        type: 'MARKET',
        quantity: '0.01',
        leverage: 5,
      }),
    ).rejects.toMatchObject({
      response: { code: 'POSITION_LEVERAGE_MISMATCH' },
    });
  });

  it('warns on low margin, liquidates, and protects the balance from a gap', async () => {
    riskTicker.price = '60000';
    riskTicker.bid = '59999.5';
    riskTicker.ask = '60000.5';
    const warning = await trading.getPortfolio(riskIdentity);
    expect(warning.riskState).toBe('MARGIN_WARNING');
    expect(Number(warning.marginLevel)).toBeCloseTo(83.325, 3);

    const resting = await trading.placeOrder(riskIdentity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side: 'SELL',
      type: 'LIMIT',
      quantity: '0.1',
      leverage: 10,
      limitPrice: '70000',
    });

    riskTicker.price = '55000';
    riskTicker.bid = '54999.5';
    riskTicker.ask = '55000.5';
    await trading.processLiquidations(riskTicker);

    const [account, position, liquidation, cancelled, ledger] =
      await Promise.all([
        database.client.account.findUniqueOrThrow({
          where: { id: warning.account.id },
        }),
        database.client.position.findFirstOrThrow({
          where: { accountId: warning.account.id },
        }),
        database.client.order.findFirstOrThrow({
          where: {
            accountId: warning.account.id,
            purpose: 'LIQUIDATION',
          },
        }),
        database.client.order.findUniqueOrThrow({
          where: { id: resting.order.id },
        }),
        database.client.ledgerEntry.findFirstOrThrow({
          where: {
            accountId: warning.account.id,
            type: 'REALIZED_PNL',
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

    expect(account.balance.toString()).toBe('0');
    expect(position.signedQuantity.toString()).toBe('0');
    expect(liquidation).toMatchObject({
      status: 'FILLED',
      reduceOnly: true,
      side: 'SELL',
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(ledger.amount.toString()).toBe('-10000');
    expect(ledger.balanceAfter.toString()).toBe('0');
    expect(ledger.metadata).toMatchObject({
      negativeBalanceProtection: true,
      protectedAmount: '1',
    });
  });
});
