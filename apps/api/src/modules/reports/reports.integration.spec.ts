import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@excess/database';

import { DatabaseService } from '../database/database.service.js';
import { parseReportQuery } from './report-query.js';
import { ReportsService } from './reports.service.js';

describe('Date-filtered trading reports', () => {
  const database = new DatabaseService();
  const reports = new ReportsService(database);
  const identity = {
    clerkUserId: `user_reports_${randomUUID()}`,
    sessionId: 'report_session',
  };
  const otherIdentity = {
    clerkUserId: `user_reports_other_${randomUUID()}`,
    sessionId: 'other_session',
  };
  const ids: { users: string[]; accounts: string[] } = {
    users: [],
    accounts: [],
  };
  const range = {
    from: '2024-01-01',
    to: '2024-01-02',
    asOf: '2024-01-03T00:00:00.000Z',
  };
  let accountId: string;
  let foreignTradeId: string;
  let firstTradeId: string;
  let ethTradeId: string;
  let beforeTradeId: string;

  async function trade(
    account: string,
    symbol: 'BTC-USD' | 'ETH-USD',
    time: string,
    price: string,
    quantity: string,
    fee = '0',
    pnl?: string,
  ) {
    const instrument = await database.client.instrument.findUniqueOrThrow({
      where: { symbol },
    });
    const order = await database.client.order.create({
      data: {
        accountId: account,
        instrumentId: instrument.id,
        clientOrderId: randomUUID(),
        side: pnl ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity,
        status: 'FILLED',
        leverage: '2',
        executedQuantity: quantity,
        averageFillPrice: price,
      },
    });
    const result = await database.client.trade.create({
      data: {
        orderId: order.id,
        accountId: account,
        instrumentId: instrument.id,
        side: order.side,
        price,
        quantity,
        fee,
        executedAt: new Date(time),
      },
    });
    if (pnl)
      await database.client.ledgerEntry.create({
        data: {
          accountId: account,
          type: 'REALIZED_PNL',
          amount: pnl,
          balanceAfter: '10000',
          referenceType: 'TRADE',
          referenceId: result.id,
          metadata: { rawRealizedPnl: '-999' },
        },
      });
    return result;
  }

  beforeAll(async () => {
    await database.onModuleInit();
    for (const subject of [identity, otherIdentity]) {
      const user = await database.client.user.create({
        data: {
          clerkId: subject.clerkUserId,
          email: 'reports-test@example.com',
          accounts: { create: { balance: '10000', initialBalance: '10000' } },
        },
        include: { accounts: true },
      });
      ids.users.push(user.id);
      ids.accounts.push(user.accounts[0]!.id);
    }
    accountId = ids.accounts[0]!;
    for (const base of ['BTC', 'ETH'])
      await database.client.instrument.upsert({
        where: { symbol: `${base}-USD` },
        update: {},
        create: {
          symbol: `${base}-USD`,
          baseCurrency: base,
          quoteCurrency: 'USD',
          pricePrecision: 2,
          quantityPrecision: 8,
          tickSize: '0.01',
          lotSize: '0.00000001',
          minimumQuantity: '0.00000001',
        },
      });
    beforeTradeId = (
      await trade(
        accountId,
        'BTC-USD',
        '2023-12-31T23:59:59.999Z',
        '500',
        '1',
        '0',
        '500',
      )
    ).id;
    firstTradeId = (
      await trade(
        accountId,
        'BTC-USD',
        '2024-01-01T00:00:00.000Z',
        '100.1234567891',
        '0.1234567891',
        '0.0000000001',
      )
    ).id;
    await trade(
      accountId,
      'BTC-USD',
      '2024-01-02T12:00:00.000Z',
      '120',
      '2',
      '0.25',
      '25.1250000001',
    );
    await trade(
      accountId,
      'BTC-USD',
      '2024-01-02T12:00:00.000Z',
      '80',
      '1',
      '0.5',
      '-5.1250000001',
    );
    ethTradeId = (
      await trade(
        accountId,
        'ETH-USD',
        '2024-01-02T23:59:59.999Z',
        '50',
        '3',
        '0.75',
        '-4',
      )
    ).id;
    await trade(
      accountId,
      'BTC-USD',
      '2024-01-03T00:00:00.000Z',
      '500',
      '1',
      '0',
      '500',
    );
    foreignTradeId = (
      await trade(
        ids.accounts[1]!,
        'BTC-USD',
        '2024-01-01T12:00:00.000Z',
        '9999',
        '1',
        '0',
        '9999',
      )
    ).id;
    // Funding and adjustments must not inflate realized performance, even when referenced to a trade.
    await database.client.ledgerEntry.createMany({
      data: [
        {
          accountId,
          type: 'DEMO_CREDIT',
          amount: '10000',
          balanceAfter: '10000',
        },
        {
          accountId,
          type: 'ADJUSTMENT',
          amount: '123',
          balanceAfter: '10123',
          referenceType: 'TRADE',
          referenceId: firstTradeId,
        },
        {
          accountId: ids.accounts[1]!,
          type: 'REALIZED_PNL',
          amount: '9999',
          balanceAfter: '9999',
          referenceType: 'TRADE',
          referenceId: firstTradeId,
        },
      ],
    });
  });

  afterAll(async () => {
    const where = { accountId: { in: ids.accounts } };
    await database.client.$transaction([
      database.client.ledgerEntry.deleteMany({ where }),
      database.client.trade.deleteMany({ where }),
      database.client.order.deleteMany({ where }),
      database.client.account.deleteMany({
        where: { id: { in: ids.accounts } },
      }),
      database.client.user.deleteMany({ where: { id: { in: ids.users } } }),
    ]);
    await database.onModuleDestroy();
  });

  it('aggregates exact decimals over inclusive UTC dates and only this account', async () => {
    const report = await reports.getReport(identity, parseReportQuery(range));
    const Decimal = Prisma.Decimal.clone({ precision: 80 });
    const notional = new Decimal('100.1234567891')
      .mul('0.1234567891')
      .add(470)
      .toFixed();
    expect(report.summary).toEqual({
      executions: 4,
      creditedRealizedPnl: '16',
      fees: '1.5000000001',
      tradedNotional: notional,
    });
    expect(report.days).toHaveLength(2);
    expect(
      report.days.map((day) => [
        day.date,
        day.executions,
        day.cumulativeRealizedPnl,
      ]),
    ).toEqual([
      ['2024-01-01', 1, '0'],
      ['2024-01-02', 3, '16'],
    ]);
    expect(report.trades.items.at(-1)).toMatchObject({
      id: firstTradeId,
      price: '100.1234567891',
      fee: '0.0000000001',
      realizedPnl: null,
    });
    expect(report.trades.items[0]).toMatchObject({
      id: ethTradeId,
      realizedPnl: '-4',
    });
    expect(report.trades.items.map((item) => item.id)).not.toContain(
      foreignTradeId,
    );
  });

  it('applies symbol filters to summaries, daily rows, and trades', async () => {
    const report = await reports.getReport(
      identity,
      parseReportQuery({ ...range, symbol: 'ETH-USD' }),
    );
    expect(report.summary).toEqual({
      executions: 1,
      tradedNotional: '150',
      fees: '0.75',
      creditedRealizedPnl: '-4',
    });
    expect(report.days[0]).toMatchObject({
      executions: 0,
      creditedRealizedPnl: '0',
      cumulativeRealizedPnl: '0',
    });
    expect(report.trades.items.map((item) => item.id)).toEqual([ethTradeId]);
  });

  it('paginates tied timestamps without duplicates and keeps full-range totals', async () => {
    const expected = await reports.getReport(identity, parseReportQuery(range));
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reports.getReport(
        identity,
        parseReportQuery({ ...range, cursor, limit: '1' }),
      );
      expect(page.summary).toEqual(expected.summary);
      found.push(...page.trades.items.map((item) => item.id));
      cursor = page.trades.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(expected.trades.items.map((item) => item.id));
    expect(new Set(found).size).toBe(4);
  });

  it('rejects foreign, out-of-range, and wrong-instrument cursors', async () => {
    for (const cursor of [foreignTradeId, beforeTradeId, randomUUID()]) {
      await expect(
        reports.getReport(identity, parseReportQuery({ ...range, cursor })),
      ).rejects.toThrow(BadRequestException);
    }
    await expect(
      reports.getReport(
        identity,
        parseReportQuery({ ...range, symbol: 'BTC-USD', cursor: ethTradeId }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('retains the execution cutoff when later trades appear', async () => {
    const query = parseReportQuery({
      ...range,
      asOf: '2024-01-01T00:00:00.000Z',
    });
    const report = await reports.getReport(identity, query);
    expect(report.summary.executions).toBe(1);
    expect(report.trades.items[0]?.id).toBe(firstTradeId);
    const later = await trade(
      accountId,
      'BTC-USD',
      '2024-01-01T00:00:01.000Z',
      '200',
      '1',
    );
    try {
      const nextPage = await reports.getReport(
        identity,
        parseReportQuery({
          ...range,
          asOf: query.filters.asOf,
          cursor: firstTradeId,
        }),
      );
      expect(nextPage.summary).toEqual(report.summary);
      expect(nextPage.trades.items).toEqual([]);
      const csv = await reports.exportCsv(identity, query);
      expect(csv).toContain(firstTradeId);
      expect(csv).not.toContain(later.id);
      expect(csv).not.toContain(ethTradeId);
    } finally {
      await database.client.trade.delete({ where: { id: later.id } });
      await database.client.order.delete({ where: { id: later.orderId } });
    }
  });

  it('fills inactive days with zero and returns a header-only empty export', async () => {
    const query = parseReportQuery({ from: '2024-02-01', to: '2024-02-03' });
    const report = await reports.getReport(identity, query);
    expect(report.summary).toEqual({
      executions: 0,
      tradedNotional: '0',
      fees: '0',
      creditedRealizedPnl: '0',
    });
    expect(report.days).toHaveLength(3);
    expect(report.trades).toEqual({ items: [], nextCursor: null });
    expect(
      (await reports.exportCsv(identity, query)).trim().split('\r\n'),
    ).toHaveLength(1);
  });

  it('exports the whole filtered range, preserving exact decimals and negative numeric P/L', async () => {
    const csv = await reports.exportCsv(
      identity,
      parseReportQuery({ ...range, limit: '1' }),
    );
    expect(csv.trim().split('\r\n')).toHaveLength(5);
    expect(csv).toContain('100.1234567891,0.1234567891');
    expect(csv).toContain(',0.75,-4,');
    expect(csv).not.toContain(foreignTradeId);
    expect(csv).not.toContain(beforeTradeId);
    const filtered = await reports.exportCsv(
      identity,
      parseReportQuery({ ...range, symbol: 'ETH-USD' }),
    );
    expect(filtered.trim().split('\r\n')).toHaveLength(2);
    expect(filtered).not.toContain('BTC-USD');
  });

  it('rejects missing users, suspended users, and suspended accounts for reports and exports', async () => {
    const query = parseReportQuery(range);
    await expect(
      reports.getReport({ ...identity, clerkUserId: randomUUID() }, query),
    ).rejects.toThrow(NotFoundException);
    await database.client.user.update({
      where: { id: ids.users[0]! },
      data: { status: 'SUSPENDED' },
    });
    try {
      await expect(reports.getReport(identity, query)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(reports.exportCsv(identity, query)).rejects.toThrow(
        ForbiddenException,
      );
    } finally {
      await database.client.user.update({
        where: { id: ids.users[0]! },
        data: { status: 'ACTIVE' },
      });
    }
    await database.client.account.update({
      where: { id: accountId },
      data: { status: 'RESTRICTED' },
    });
    try {
      await expect(reports.getReport(identity, query)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(reports.exportCsv(identity, query)).rejects.toThrow(
        ForbiddenException,
      );
    } finally {
      await database.client.account.update({
        where: { id: accountId },
        data: { status: 'ACTIVE' },
      });
    }
  });
});
