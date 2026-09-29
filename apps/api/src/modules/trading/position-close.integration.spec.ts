import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@excess/database';
import type { MarketTicker } from '@excess/shared-types';
import { jest } from '@jest/globals';

import type { ClerkGateway, ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import type { MarketDataService } from '../market-data/market-data.service.js';
import { SessionService } from '../session/session.service.js';
import { TradingService } from './trading.service.js';

const btc: MarketTicker = {
  symbol: 'BTC-USD',
  price: '65000',
  bid: '64999.5',
  ask: '65000.5',
  change24h: '0',
  high24h: '66000',
  low24h: '64000',
  volume24h: '1000',
  status: 'LIVE',
  source: 'SIMULATED',
  updatedAt: new Date().toISOString(),
};
const eth: MarketTicker = {
  ...btc,
  symbol: 'ETH-USD',
  price: '3500',
  bid: '3499.95',
  ask: '3500.05',
};

describe('Reduce-only position closing', () => {
  const database = new DatabaseService();
  const ticker = jest.fn((symbol: string) =>
    symbol === 'BTC-USD' ? btc : eth,
  );
  const trading = new TradingService(database, {
    getCurrentTicker: ticker,
  } as unknown as MarketDataService);
  const session = new SessionService(database, {
    getUserProfile: async (clerkUserId: string) => ({
      clerkUserId,
      email: 'close@example.com',
      displayName: 'Position closer',
    }),
  } as unknown as ClerkGateway);
  let identity: ClerkIdentity;
  let clerkIds: string[] = [];

  async function newTrader() {
    const clerkUserId = `user_close_${randomUUID()}`;
    clerkIds.push(clerkUserId);
    const trader = { clerkUserId, sessionId: 'session_close' };
    await session.bootstrap(trader);
    return trader;
  }
  async function open(
    side: 'BUY' | 'SELL' = 'BUY',
    quantity = '0.01',
    protection = false,
  ) {
    const response = await trading.placeOrder(identity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      side,
      quantity,
      type: 'MARKET',
      leverage: 5,
      ...(protection
        ? { stopLossPrice: '64000', takeProfitPrice: '66000' }
        : {}),
    });
    return {
      response,
      position: response.portfolio.positions.find(
        (item) => item.symbol === 'BTC-USD',
      )!,
    };
  }
  function close(
    position: { id: string; version: number },
    clientOrderId: string = randomUUID(),
  ) {
    return trading.closePosition(identity, position.id, {
      clientOrderId,
      expectedVersion: position.version,
    });
  }

  beforeAll(async () => {
    await database.onModuleInit();
    for (const [symbol, baseCurrency] of [
      ['BTC-USD', 'BTC'],
      ['ETH-USD', 'ETH'],
    ] as const) {
      await database.client.instrument.upsert({
        where: { symbol },
        create: {
          symbol,
          baseCurrency,
          quoteCurrency: 'USD',
          pricePrecision: 2,
          quantityPrecision: 8,
          tickSize: '0.01',
          lotSize: '0.00000001',
          minimumQuantity: '0.00000001',
        },
        update: {},
      });
    }
  });
  beforeEach(async () => {
    ticker.mockImplementation((symbol) => (symbol === 'BTC-USD' ? btc : eth));
    clerkIds = [];
    identity = await newTrader();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const users = await database.client.user.findMany({
      where: { clerkId: { in: clerkIds } },
      include: { accounts: true },
    });
    const accountIds = users.flatMap((user) =>
      user.accounts.map((account) => account.id),
    );
    const orders = await database.client.order.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    });
    await database.client.$transaction([
      database.client.outboxEvent.deleteMany({
        where: { aggregateId: { in: orders.map((order) => order.id) } },
      }),
      database.client.auditEvent.deleteMany({
        where: { actorUserId: { in: users.map((user) => user.id) } },
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
      database.client.account.deleteMany({ where: { id: { in: accountIds } } }),
      database.client.user.deleteMany({ where: { clerkId: { in: clerkIds } } }),
    ]);
  });
  afterAll(async () => {
    await database.onModuleDestroy();
  });

  it('closes the exact long size, cancels protection, and retains other exposure and entry orders', async () => {
    const { response: entry, position } = await open('BUY', '0.01', true);
    const pending = await trading.placeOrder(identity, {
      clientOrderId: randomUUID(),
      symbol: 'BTC-USD',
      type: 'LIMIT',
      side: 'BUY',
      quantity: '0.01',
      limitPrice: '60000',
    });
    await trading.placeOrder(identity, {
      clientOrderId: randomUUID(),
      symbol: 'ETH-USD',
      type: 'MARKET',
      side: 'BUY',
      quantity: '0.1',
    });
    const receipt = await close(position);
    expect(receipt.order).toMatchObject({
      side: 'SELL',
      purpose: 'POSITION_CLOSE',
      reduceOnly: true,
      status: 'FILLED',
      quantity: '0.01',
      leverage: 5,
    });
    expect(receipt.trade).toMatchObject({ price: btc.bid, quantity: '0.01' });
    expect(receipt.portfolio.positions.map((item) => item.symbol)).toEqual([
      'ETH-USD',
    ]);
    expect(receipt.portfolio.account.balance).toBe('9999.99');
    const closed = await database.client.position.findUniqueOrThrow({
      where: { id: position.id },
    });
    expect(closed.signedQuantity.toString()).toBe('0');
    expect(closed.version).toBe(position.version + 1);
    const openOrders = await trading.getOpenOrders(identity);
    expect(openOrders.items.map((item) => item.id)).toEqual([pending.order.id]);
    expect(
      await database.client.order.count({
        where: {
          id: { in: entry.relatedOrders.map((order) => order.id) },
          status: 'CANCELLED',
        },
      }),
    ).toBe(2);
    const ledger = await database.client.ledgerEntry.findFirstOrThrow({
      where: { referenceType: 'TRADE', referenceId: receipt.trade!.id },
    });
    expect(ledger.amount.toString()).toBe('-0.01');
    expect(
      await database.client.auditEvent.count({
        where: { resourceId: receipt.order.id, action: 'ORDER_FILLED' },
      }),
    ).toBe(1);
    expect(
      await database.client.outboxEvent.count({
        where: { aggregateId: receipt.order.id, eventType: 'ORDER_FILLED' },
      }),
    ).toBe(1);
  });

  it('closes a short with a buy and preserves the minimum lot and decimal ledger precision', async () => {
    const { position } = await open('SELL', '0.00000001');
    const receipt = await close(position);
    expect(receipt.trade).toMatchObject({
      side: 'BUY',
      price: btc.ask,
    });
    expect(
      new Prisma.Decimal(receipt.trade!.quantity).equals('0.00000001'),
    ).toBe(true);
    expect(receipt.portfolio.positions).toEqual([]);
    expect(receipt.portfolio.usedMargin).toBe('0');
    expect(receipt.portfolio.account.balance).toBe('9999.99999999');
  });

  it('executes concurrent retries with the same request key exactly once', async () => {
    const { position } = await open();
    const key = randomUUID();
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => close(position, key)),
    );
    expect(new Set(receipts.map((receipt) => receipt.order.id)).size).toBe(1);
    expect(
      await database.client.trade.count({
        where: { orderId: receipts[0]!.order.id },
      }),
    ).toBe(1);
    expect(
      await database.client.ledgerEntry.count({
        where: { referenceType: 'TRADE', referenceId: receipts[0]!.trade!.id },
      }),
    ).toBe(1);
  });

  it('allows only one concurrent close with different keys and never reverses exposure', async () => {
    const { position } = await open();
    const results = await Promise.allSettled([
      close(position),
      close(position),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toBeInstanceOf(
      ConflictException,
    );
    expect((await trading.getPortfolio(identity)).positions).toEqual([]);
    expect(
      await database.client.order.count({
        where: {
          purpose: 'POSITION_CLOSE',
          account: { user: { clerkId: identity.clerkUserId } },
        },
      }),
    ).toBe(1);
  });

  it('rejects stale confirmation after a fill and closes only after a new review', async () => {
    const { position } = await open();
    const { position: changed } = await open();
    expect(changed.version).toBe(position.version + 1);
    await expect(close(position)).rejects.toMatchObject({
      response: { code: 'POSITION_CHANGED' },
    });
    expect(
      (await trading.getPortfolio(identity)).positions[0]!.signedQuantity,
    ).toBe('0.02');
    await close(changed);
  });

  it('replays a completed close without touching a reopened position and rejects old versions', async () => {
    const { position } = await open();
    const key = randomUUID();
    const original = await close(position, key);
    await expect(close(position)).rejects.toMatchObject({
      response: { code: 'POSITION_NOT_OPEN' },
    });
    const { position: reopened } = await open('SELL');
    expect(reopened.id).toBe(position.id);
    expect(reopened.leverage).toBe(5);
    expect(reopened.version).toBeGreaterThan(position.version);
    const replay = await close(position, key);
    expect(replay.trade?.id).toBe(original.trade?.id);
    expect(replay.portfolio.positions[0]!.signedQuantity).toBe('-0.01');
    await expect(close(position)).rejects.toMatchObject({
      response: { code: 'POSITION_CHANGED' },
    });
  });

  it('does not expose or close another user’s position', async () => {
    const { position } = await open();
    const stranger = await newTrader();
    await expect(
      trading.closePosition(stranger, position.id, {
        clientOrderId: randomUUID(),
        expectedVersion: position.version,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      (await trading.getPortfolio(identity)).positions[0]!.signedQuantity,
    ).toBe('0.01');
  });

  it.each(['RESTRICTED', 'CLOSED'] as const)(
    'rejects a %s account',
    async (status) => {
      const { position, response } = await open();
      await database.client.account.update({
        where: { id: response.portfolio.account.id },
        data: { status },
      });
      await expect(close(position)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it.each(['suspended', 'deleted'] as const)(
    'rejects a %s identity',
    async (kind) => {
      const { position } = await open();
      await database.client.user.update({
        where: { clerkId: identity.clerkUserId },
        data:
          kind === 'suspended'
            ? { status: 'SUSPENDED' }
            : { identityDeletedAt: new Date() },
      });
      await expect(close(position)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('rejects stale quotes without writing an order and can replay a finished close without live quotes', async () => {
    const { position } = await open();
    ticker.mockImplementation(() => ({ ...btc, status: 'STALE' }));
    await expect(close(position)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    ticker.mockImplementation(() => btc);
    const key = randomUUID();
    const completed = await close(position, key);
    ticker.mockImplementation(() => ({ ...btc, status: 'STALE' }));
    expect((await close(position, key)).order.id).toBe(completed.order.id);
  });

  it('rejects a request key belonging to an entry or a different position', async () => {
    const { position, response } = await open();
    await expect(
      close(position, response.order.clientOrderId),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    const ethEntry = await trading.placeOrder(identity, {
      type: 'MARKET',
      side: 'BUY',
      symbol: 'ETH-USD',
      quantity: '0.1',
      clientOrderId: randomUUID(),
    });
    const ethPosition = ethEntry.portfolio.positions.find(
      (item) => item.symbol === 'ETH-USD',
    )!;
    const key = randomUUID();
    await trading.closePosition(identity, ethPosition.id, {
      clientOrderId: key,
      expectedVersion: ethPosition.version,
    });
    await expect(close(position, key)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
  });

  it('rolls back the position, cash, protection and execution if the audit write fails', async () => {
    const { position, response } = await open('BUY', '0.01', true);
    const original = database.client.$transaction.bind(database.client);
    const spy = jest.spyOn(database.client, '$transaction');
    spy.mockImplementation(((
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options: unknown,
    ) =>
      original(
        async (tx) =>
          callback(
            new Proxy(tx, {
              get(target, property) {
                if (property === 'auditEvent')
                  return new Proxy(target.auditEvent, {
                    get(delegate, method) {
                      if (method === 'create')
                        return async () => {
                          throw new Error('Audit unavailable');
                        };
                      return Reflect.get(delegate, method);
                    },
                  });
                return Reflect.get(target, property);
              },
            }),
          ),
        options as never,
      )) as typeof database.client.$transaction);
    await expect(close(position)).rejects.toThrow('Audit unavailable');
    spy.mockRestore();
    const current = await trading.getPortfolio(identity);
    expect(current.positions[0]).toMatchObject({
      version: position.version,
      signedQuantity: position.signedQuantity,
    });
    expect(current.account.balance).toBe(response.portfolio.account.balance);
    expect((await trading.getOpenOrders(identity)).items).toHaveLength(2);
    expect(
      await database.client.order.count({
        where: { purpose: 'POSITION_CLOSE', accountId: current.account.id },
      }),
    ).toBe(0);
  });

  it('safely competes with a triggered stop loss without opening an opposite position', async () => {
    const { position } = await open('BUY', '0.01', true);
    const stopTicker = {
      ...btc,
      price: '63999',
      bid: '63998.5',
      ask: '63999.5',
    };
    ticker.mockImplementation(() => stopTicker);
    await Promise.allSettled([
      close(position),
      trading.processPendingOrders(stopTicker),
    ]);
    expect((await trading.getPortfolio(identity)).positions).toEqual([]);
    expect(
      await database.client.trade.count({ where: { positionId: position.id } }),
    ).toBe(2);
  });

  it.each([false, true])(
    'protects negative balances during a gap close (concurrent liquidation: %s)',
    async (withLiquidation) => {
      const entry = await trading.placeOrder(identity, {
        clientOrderId: randomUUID(),
        symbol: 'BTC-USD',
        type: 'MARKET',
        side: 'BUY',
        quantity: '1',
        leverage: 10,
      });
      const position = entry.portfolio.positions[0]!;
      const crash = { ...btc, price: '1', bid: '0.5', ask: '1.5' };
      ticker.mockImplementation(() => crash);
      if (withLiquidation) {
        await Promise.allSettled([
          close(position),
          trading.processLiquidations(crash),
        ]);
      } else {
        await close(position);
      }
      const portfolio = await trading.getPortfolio(identity);
      expect(portfolio.positions).toEqual([]);
      expect(portfolio.account.balance).toBe('0');
      expect(
        await database.client.trade.count({
          where: { positionId: position.id },
        }),
      ).toBe(2);
      const stored = await database.client.position.findUniqueOrThrow({
        where: { id: position.id },
      });
      expect(stored.version).toBe(position.version + 1);
      const ledger = await database.client.ledgerEntry.aggregate({
        where: { accountId: portfolio.account.id },
        _sum: { amount: true },
      });
      expect(ledger._sum.amount?.toString()).toBe('0');
    },
  );
});
