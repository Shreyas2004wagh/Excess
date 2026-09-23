import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@excess/database';
import type {
  Leverage,
  TradeHistoryItem,
  TradingReport,
  TradingReportDay,
  TradingReportTotals,
} from '@excess/shared-types';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import type { ReportQuery } from './report-query.js';

export const MAX_EXPORT_ROWS = 10_000;
// Two Decimal(28,10) values can produce a 56-digit notional before aggregation.
const ReportDecimal = Prisma.Decimal.clone({ precision: 80 });
type ReportTrade = Prisma.TradeGetPayload<{
  include: { instrument: true; order: true };
}>;
type DailyAggregate = {
  date: string;
  executions: bigint;
  tradedNotional: Prisma.Decimal;
  fees: Prisma.Decimal;
  creditedRealizedPnl: Prisma.Decimal;
};

function tradeFilter(
  accountId: string,
  query: ReportQuery,
): Prisma.TradeWhereInput {
  return {
    accountId,
    executedAt: { gte: query.start, lt: query.endExclusive, lte: query.cutoff },
    ...(query.filters.symbol
      ? { instrument: { symbol: query.filters.symbol } }
      : {}),
  };
}

async function serializeTrades(
  tx: Prisma.TransactionClient,
  accountId: string,
  trades: ReportTrade[],
): Promise<TradeHistoryItem[]> {
  const entries = await tx.ledgerEntry.groupBy({
    by: ['referenceId'],
    where: {
      accountId,
      type: 'REALIZED_PNL',
      referenceType: 'TRADE',
      referenceId: { in: trades.map((trade) => trade.id) },
    },
    _sum: { amount: true },
  });
  const realized = new Map(
    entries.map((entry) => [
      entry.referenceId,
      entry._sum.amount?.toFixed() ?? null,
    ]),
  );
  return trades.map((trade) => ({
    id: trade.id,
    orderId: trade.orderId,
    symbol: trade.instrument.symbol,
    side: trade.side,
    orderType: trade.order.type,
    purpose: trade.order.purpose,
    leverage: Number(trade.order.leverage) as Leverage,
    price: trade.price.toFixed(),
    quantity: trade.quantity.toFixed(),
    fee: trade.fee.toFixed(),
    spreadBps: trade.spreadBps.toFixed(),
    slippageBps: trade.slippageBps.toFixed(),
    executedAt: trade.executedAt.toISOString(),
    realizedPnl: realized.get(trade.id) ?? null,
  }));
}

// Text fields are escaped against CSV formula injection; numeric fields are
// generated from trusted Decimal values, so legitimate losses remain numeric.
function csvText(value: string) {
  const safe = /^[\s]*[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

@Injectable()
export class ReportsService {
  constructor(private readonly database: DatabaseService) {}

  private async accountId(
    tx: Prisma.TransactionClient,
    identity: ClerkIdentity,
  ) {
    const user = await tx.user.findUnique({
      where: { clerkId: identity.clerkUserId },
      include: { accounts: { where: { type: 'DEMO', baseCurrency: 'USD' } } },
    });
    if (!user)
      throw new NotFoundException({
        code: 'SESSION_NOT_BOOTSTRAPPED',
        message: 'Bootstrap your session first.',
      });
    const account = user.accounts[0];
    if (
      user.status !== 'ACTIVE' ||
      user.identityDeletedAt ||
      (account && account.status !== 'ACTIVE')
    ) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account is suspended.',
      });
    }
    if (!account)
      throw new NotFoundException({
        code: 'DEMO_ACCOUNT_NOT_FOUND',
        message: 'No USD demo account exists.',
      });
    return account.id;
  }

  async getReport(
    identity: ClerkIdentity,
    query: ReportQuery,
  ): Promise<TradingReport> {
    return this.database.client.$transaction(
      async (tx) => {
        const accountId = await this.accountId(tx, identity);
        const where = tradeFilter(accountId, query);
        let boundary: Prisma.TradeWhereInput = {};
        if (query.cursor) {
          const cursor = await tx.trade.findFirst({
            where: { ...where, id: query.cursor },
            select: { executedAt: true, id: true },
          });
          if (!cursor)
            throw new BadRequestException({
              code: 'INVALID_REPORT_CURSOR',
              message:
                'The cursor does not belong to this account and report range.',
            });
          boundary = {
            OR: [
              { executedAt: { lt: cursor.executedAt } },
              { executedAt: cursor.executedAt, id: { lt: cursor.id } },
            ],
          };
        }
        const trades = await tx.trade.findMany({
          where: { AND: [where, boundary] },
          orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
          include: { instrument: true, order: true },
        });
        // Aggregate in PostgreSQL instead of loading the account's entire history.
        // Timestamp columns store UTC; grouping is independent of the DB session timezone.
        const aggregates = await tx.$queryRaw<DailyAggregate[]>(Prisma.sql`
        SELECT to_char(t."executedAt", 'YYYY-MM-DD') AS date,
          count(*) AS executions, sum(t.price * t.quantity) AS "tradedNotional",
          sum(t.fee) AS fees, coalesce(sum(l.amount), 0) AS "creditedRealizedPnl"
        FROM "Trade" t JOIN "Instrument" i ON i.id = t."instrumentId"
        LEFT JOIN (
          SELECT "referenceId", sum(amount) AS amount FROM "LedgerEntry"
          WHERE "accountId" = ${accountId}::uuid AND type = 'REALIZED_PNL' AND "referenceType" = 'TRADE'
          GROUP BY "referenceId"
        ) l ON l."referenceId" = t.id::text
        WHERE t."accountId" = ${accountId}::uuid AND t."executedAt" >= ${query.start}
          AND t."executedAt" < ${query.endExclusive} AND t."executedAt" <= ${query.cutoff}
          ${query.filters.symbol ? Prisma.sql`AND i.symbol = ${query.filters.symbol}` : Prisma.empty}
        GROUP BY to_char(t."executedAt", 'YYYY-MM-DD') ORDER BY date ASC
      `);
        const byDate = new Map(aggregates.map((day) => [day.date, day]));
        const summary: TradingReportTotals = {
          executions: 0,
          tradedNotional: '0',
          fees: '0',
          creditedRealizedPnl: '0',
        };
        const days: TradingReportDay[] = [];
        for (
          let date = query.start.getTime();
          date < query.endExclusive.getTime();
          date += 86_400_000
        ) {
          const label = new Date(date).toISOString().slice(0, 10);
          const row = byDate.get(label);
          const day = {
            date: label,
            executions: Number(row?.executions ?? 0),
            tradedNotional: row?.tradedNotional.toFixed() ?? '0',
            fees: row?.fees.toFixed() ?? '0',
            creditedRealizedPnl: row?.creditedRealizedPnl.toFixed() ?? '0',
          };
          summary.executions += day.executions;
          for (const field of [
            'tradedNotional',
            'fees',
            'creditedRealizedPnl',
          ] as const) {
            summary[field] = new ReportDecimal(summary[field])
              .add(day[field])
              .toFixed();
          }
          days.push({
            ...day,
            cumulativeRealizedPnl: summary.creditedRealizedPnl,
          });
        }
        const page = trades.slice(0, query.limit);
        return {
          filters: query.filters,
          summary,
          days,
          trades: {
            items: await serializeTrades(tx, accountId, page),
            nextCursor: trades.length > query.limit ? page.at(-1)!.id : null,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async exportCsv(identity: ClerkIdentity, query: ReportQuery) {
    const trades = await this.database.client.$transaction(
      async (tx) => {
        const accountId = await this.accountId(tx, identity);
        const rows = await tx.trade.findMany({
          where: tradeFilter(accountId, query),
          orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
          take: MAX_EXPORT_ROWS + 1,
          include: { instrument: true, order: true },
        });
        if (rows.length > MAX_EXPORT_ROWS) {
          throw new UnprocessableEntityException({
            code: 'REPORT_EXPORT_TOO_LARGE',
            message:
              'This export exceeds 10,000 executions. Choose a shorter date range or one instrument.',
          });
        }
        return serializeTrades(tx, accountId, rows);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const header =
      'execution_id,order_id,executed_at_utc,symbol,side,order_type,purpose,leverage,price_usd,quantity,notional_usd,fee_usd,credited_realized_pnl_usd,spread_bps,slippage_bps';
    const rows = trades.map((trade) =>
      [
        ...[
          trade.id,
          trade.orderId,
          trade.executedAt,
          trade.symbol,
          trade.side,
          trade.orderType,
          trade.purpose,
        ].map(csvText),
        trade.leverage,
        trade.price,
        trade.quantity,
        new ReportDecimal(trade.price).mul(trade.quantity).toFixed(),
        trade.fee,
        trade.realizedPnl ?? '',
        trade.spreadBps,
        trade.slippageBps,
      ].join(','),
    );
    return [header, ...rows].join('\r\n') + '\r\n';
  }
}
