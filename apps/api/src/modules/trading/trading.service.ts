import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AccountStatus,
  AccountType,
  InstrumentStatus,
  Prisma,
  UserStatus,
  type Account,
  type Instrument,
  type User,
} from '@excess/database';
import type {
  DemoAccountSummary,
  Leverage,
  MarketOrderRequest,
  MarketOrderResponse,
  MarketSymbol,
  MarketTicker,
  OpenOrdersResponse,
  OrderPlacementRequest,
  OrderPlacementResponse,
  OrderSummary,
  PortfolioSummary,
  PositionSummary,
  TradeHistoryItem,
  TradeHistoryPage,
  TradeSummary,
  TradingPerformanceSummary,
} from '@excess/shared-types';
import {
  calculateAccountMetrics,
  calculatePositionMargin,
} from '@excess/risk-engine';
import {
  applyFillToPosition,
  calculateUnrealizedPnl,
  shouldTriggerPendingOrder,
} from '@excess/trading-engine';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import { MarketDataService } from '../market-data/market-data.service.js';

const MAX_TRANSACTION_ATTEMPTS = 5;
const SUPPORTED_LEVERAGE = [1, 2, 5, 10] as const;

type AccountWithPositions = Prisma.AccountGetPayload<{
  include: { positions: { include: { instrument: true } } };
}>;
type OrderWithInstrument = Prisma.OrderGetPayload<{
  include: { instrument: true };
}>;
type OrderWithReceipt = Prisma.OrderGetPayload<{
  include: { instrument: true; trades: { take: 1 } };
}>;
type TradeContext = { user: User; account: Account; instrument: Instrument };
type TradeHistoryRecord = Prisma.TradeGetPayload<{
  include: { instrument: true; order: true };
}>;
type RiskPosition = {
  signedQuantity: Prisma.Decimal;
  averageEntryPrice: Prisma.Decimal | null;
  leverage: Prisma.Decimal;
  instrument: { symbol: string };
};

function isRetryableTransactionError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002')
  );
}

function serializeAccount(account: AccountWithPositions): DemoAccountSummary {
  return {
    id: account.id,
    type: account.type,
    baseCurrency: account.baseCurrency,
    balance: account.balance.toString(),
    initialBalance: account.initialBalance.toString(),
    status: account.status,
    createdAt: account.createdAt.toISOString(),
  };
}

function serializeOrder(order: OrderWithInstrument): OrderSummary {
  return {
    id: order.id,
    clientOrderId: order.clientOrderId,
    symbol: order.instrument.symbol,
    side: order.side,
    type: order.type,
    quantity: order.quantity.toString(),
    leverage: Number(order.leverage) as Leverage,
    requestedPrice: order.requestedPrice?.toString() ?? null,
    stopPrice: order.stopPrice?.toString() ?? null,
    stopLossPrice: order.stopLossPrice?.toString() ?? null,
    takeProfitPrice: order.takeProfitPrice?.toString() ?? null,
    executedQuantity: order.executedQuantity.toString(),
    averageFillPrice: order.averageFillPrice?.toString() ?? null,
    status: order.status,
    purpose: order.purpose,
    reduceOnly: order.reduceOnly,
    parentOrderId: order.parentOrderId,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

function serializeTrade(
  trade: OrderWithReceipt['trades'][number],
  order: OrderWithReceipt,
): TradeSummary {
  return {
    id: trade.id,
    orderId: order.id,
    symbol: order.instrument.symbol,
    side: trade.side,
    price: trade.price.toString(),
    quantity: trade.quantity.toString(),
    fee: trade.fee.toString(),
    spreadBps: trade.spreadBps.toString(),
    slippageBps: trade.slippageBps.toString(),
    executedAt: trade.executedAt.toISOString(),
  };
}

function serializeTradeHistoryItem(
  trade: TradeHistoryRecord,
  realizedPnl: Prisma.Decimal | null,
): TradeHistoryItem {
  return {
    id: trade.id,
    orderId: trade.orderId,
    symbol: trade.instrument.symbol,
    side: trade.side,
    price: trade.price.toString(),
    quantity: trade.quantity.toString(),
    fee: trade.fee.toString(),
    spreadBps: trade.spreadBps.toString(),
    slippageBps: trade.slippageBps.toString(),
    executedAt: trade.executedAt.toISOString(),
    orderType: trade.order.type,
    purpose: trade.order.purpose,
    leverage: Number(trade.order.leverage) as Leverage,
    realizedPnl: realizedPnl?.toString() ?? null,
  };
}

function positionSummary(
  position: AccountWithPositions['positions'][number],
  markPrice: Prisma.Decimal,
): PositionSummary {
  const unrealizedPnl = position.averageEntryPrice
    ? new Prisma.Decimal(
        calculateUnrealizedPnl({
          averageEntryPrice: position.averageEntryPrice.toString(),
          markPrice: markPrice.toString(),
          signedQuantity: position.signedQuantity.toString(),
        }),
      )
    : new Prisma.Decimal(0);
  const usedMargin = calculatePositionMargin({
    signedQuantity: position.signedQuantity.toString(),
    markPrice: markPrice.toString(),
    leverage: position.leverage.toString(),
  });

  return {
    id: position.id,
    symbol: position.instrument.symbol,
    signedQuantity: position.signedQuantity.toString(),
    averageEntryPrice: position.averageEntryPrice?.toString() ?? null,
    markPrice: markPrice.toString(),
    notional: position.signedQuantity.abs().mul(markPrice).toString(),
    leverage: Number(position.leverage) as Leverage,
    usedMargin,
    realizedPnl: position.realizedPnl.toString(),
    unrealizedPnl: unrealizedPnl.toString(),
    updatedAt: position.updatedAt.toISOString(),
  };
}

function serializePortfolio(
  account: AccountWithPositions,
  tickers: ReadonlyMap<string, MarketTicker>,
): PortfolioSummary {
  const positions = account.positions
    .filter((position) => !position.signedQuantity.isZero())
    .flatMap((position) => {
      const ticker = tickers.get(position.instrument.symbol);
      return ticker
        ? [positionSummary(position, new Prisma.Decimal(ticker.price))]
        : [];
    });
  const unrealizedPnl = positions.reduce(
    (total, position) => total.plus(position.unrealizedPnl),
    new Prisma.Decimal(0),
  );
  const usedMargin = positions.reduce(
    (total, position) => total.plus(position.usedMargin),
    new Prisma.Decimal(0),
  );
  const metrics = calculateAccountMetrics({
    balance: account.balance.toString(),
    unrealizedPnl: unrealizedPnl.toString(),
    usedMargin: usedMargin.toString(),
  });

  return {
    account: serializeAccount(account),
    equity: metrics.equity,
    unrealizedPnl: unrealizedPnl.toString(),
    usedMargin: metrics.usedMargin,
    freeMargin: metrics.freeMargin,
    marginLevel: metrics.marginLevel,
    riskState: metrics.riskState,
    positions,
  };
}

@Injectable()
export class TradingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TradingService.name);
  private unsubscribeMarketData: (() => void) | null = null;
  private readonly processingPendingOrders = new Set<string>();
  private readonly processingLiquidations = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly marketData: MarketDataService,
  ) {}

  onApplicationBootstrap() {
    this.unsubscribeMarketData = this.marketData.subscribe((event) => {
      if (event.event === 'market:ticker') {
        void this.processMarketTick(event.data);
      }
    });
  }

  onModuleDestroy() {
    this.unsubscribeMarketData?.();
  }

  async placeOrder(
    identity: ClerkIdentity,
    request: OrderPlacementRequest,
  ): Promise<OrderPlacementResponse> {
    const ticker = this.requireLiveTicker(request.symbol);
    const orderId = await this.inSerializableTransaction(
      async (transaction) => {
        const context = await this.getTradeContext(
          transaction,
          identity,
          request.symbol,
        );
        const duplicate = await transaction.order.findUnique({
          where: {
            accountId_clientOrderId: {
              accountId: context.account.id,
              clientOrderId: request.clientOrderId,
            },
          },
          select: { id: true },
        });
        if (duplicate) return duplicate.id;

        const quantity = new Prisma.Decimal(request.quantity);
        this.validateQuantity(quantity, context.instrument);
        const leverage = request.leverage ?? 1;
        this.validateLeverage(leverage);
        this.validateOrderPrices(request, ticker, context.instrument);
        const order = await transaction.order.create({
          data: {
            accountId: context.account.id,
            instrumentId: context.instrument.id,
            clientOrderId: request.clientOrderId,
            side: request.side,
            type: request.type,
            quantity,
            leverage,
            requestedPrice:
              request.type === 'LIMIT' ? request.limitPrice : null,
            stopPrice: request.type === 'STOP' ? request.stopPrice : null,
            stopLossPrice: request.stopLossPrice ?? null,
            takeProfitPrice: request.takeProfitPrice ?? null,
            status: request.type === 'MARKET' ? 'PENDING' : 'ACCEPTED',
          },
          include: { instrument: true },
        });

        const shouldFill =
          request.type === 'MARKET' ||
          shouldTriggerPendingOrder({
            side: order.side,
            type: order.type as 'LIMIT' | 'STOP',
            requestedPrice: order.requestedPrice?.toString() ?? null,
            stopPrice: order.stopPrice?.toString() ?? null,
            bid: ticker.bid,
            ask: ticker.ask,
          });
        if (shouldFill) {
          await this.fillOrder(transaction, context, order, ticker);
        } else {
          await transaction.auditEvent.create({
            data: {
              actorUserId: context.user.id,
              action: 'ORDER_ACCEPTED',
              resourceType: 'ORDER',
              resourceId: order.id,
              metadata: {
                accountId: context.account.id,
                symbol: context.instrument.symbol,
                type: order.type,
                side: order.side,
                quantity: order.quantity.toString(),
                leverage: order.leverage.toString(),
                requestedPrice: order.requestedPrice?.toString() ?? null,
                stopPrice: order.stopPrice?.toString() ?? null,
              },
            },
          });
        }
        return order.id;
      },
    );

    return this.getOrderReceipt(identity, orderId);
  }

  async placeMarketOrder(
    identity: ClerkIdentity,
    request: MarketOrderRequest,
  ): Promise<MarketOrderResponse> {
    const result = await this.placeOrder(identity, request);
    if (!result.trade) {
      throw new ServiceUnavailableException({
        code: 'ORDER_EXECUTION_UNAVAILABLE',
        message: 'The market order was not filled',
      });
    }
    return { ...result, trade: result.trade };
  }

  async getPortfolio(identity: ClerkIdentity): Promise<PortfolioSummary> {
    const account = await this.findAccountWithPositions(identity);
    return serializePortfolio(account, this.requirePortfolioTickers(account));
  }

  async getOpenOrders(identity: ClerkIdentity): Promise<OpenOrdersResponse> {
    const account = await this.findAccountWithPositions(identity);
    const orders = await this.database.client.order.findMany({
      where: { accountId: account.id, status: 'ACCEPTED' },
      include: { instrument: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: orders.map(serializeOrder) };
  }

  async getTradeHistory(
    identity: ClerkIdentity,
    query: { limit: number; cursor?: string; symbol?: MarketSymbol },
  ): Promise<TradeHistoryPage> {
    const account = await this.findAccountWithPositions(identity);
    let cursorBoundary: { executedAt: Date; id: string } | undefined;
    if (query.cursor) {
      const cursor = await this.database.client.trade.findFirst({
        where: {
          id: query.cursor,
          accountId: account.id,
          ...(query.symbol
            ? { instrument: { symbol: query.symbol } }
            : undefined),
        },
        select: { id: true, executedAt: true },
      });
      if (!cursor) {
        throw new BadRequestException({
          code: 'TRADE_CURSOR_NOT_FOUND',
          message: 'The trade-history cursor is invalid',
        });
      }
      cursorBoundary = cursor;
    }

    const trades = await this.database.client.trade.findMany({
      where: {
        accountId: account.id,
        ...(query.symbol
          ? { instrument: { symbol: query.symbol } }
          : undefined),
        ...(cursorBoundary
          ? {
              OR: [
                { executedAt: { lt: cursorBoundary.executedAt } },
                {
                  executedAt: cursorBoundary.executedAt,
                  id: { lt: cursorBoundary.id },
                },
              ],
            }
          : undefined),
      },
      include: { instrument: true, order: true },
      orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const pageItems = trades.slice(0, query.limit);
    const realizedEntries = await this.database.client.ledgerEntry.findMany({
      where: {
        accountId: account.id,
        type: 'REALIZED_PNL',
        referenceType: 'TRADE',
        referenceId: { in: pageItems.map((trade) => trade.id) },
      },
      select: { referenceId: true, amount: true },
    });
    const realizedByTrade = new Map(
      realizedEntries.flatMap((entry) =>
        entry.referenceId ? [[entry.referenceId, entry.amount] as const] : [],
      ),
    );

    return {
      items: pageItems.map((trade) =>
        serializeTradeHistoryItem(trade, realizedByTrade.get(trade.id) ?? null),
      ),
      nextCursor:
        trades.length > query.limit ? (pageItems.at(-1)?.id ?? null) : null,
    };
  }

  async getPerformance(
    identity: ClerkIdentity,
  ): Promise<TradingPerformanceSummary> {
    const account = await this.findAccountWithPositions(identity);
    const [trades, realizedEntries] = await Promise.all([
      this.database.client.trade.findMany({
        where: { accountId: account.id },
        select: { price: true, quantity: true },
      }),
      this.database.client.ledgerEntry.findMany({
        where: { accountId: account.id, type: 'REALIZED_PNL' },
        select: { amount: true },
      }),
    ]);
    const zero = new Prisma.Decimal(0);
    const tradedNotional = trades.reduce(
      (total, trade) => total.plus(trade.price.mul(trade.quantity)),
      zero,
    );
    const realizedValues = realizedEntries.map((entry) => entry.amount);
    const wins = realizedValues.filter((amount) => amount.isPositive());
    const losses = realizedValues.filter((amount) => amount.isNegative());
    const grossProfit = wins.reduce(
      (total, amount) => total.plus(amount),
      zero,
    );
    const grossLoss = losses.reduce(
      (total, amount) => total.plus(amount),
      zero,
    );
    const netRealizedPnl = grossProfit.plus(grossLoss);
    const resolvedTrades = wins.length + losses.length;

    return {
      totalTrades: trades.length,
      activePositions: account.positions.filter(
        (position) => !position.signedQuantity.isZero(),
      ).length,
      realizedEvents: realizedEntries.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate:
        resolvedTrades === 0
          ? null
          : new Prisma.Decimal(wins.length)
              .div(resolvedTrades)
              .mul(100)
              .toDecimalPlaces(2)
              .toString(),
      grossProfit: grossProfit.toString(),
      grossLoss: grossLoss.toString(),
      netRealizedPnl: netRealizedPnl.toString(),
      tradedNotional: tradedNotional.toString(),
      averageTradeNotional:
        trades.length === 0
          ? '0'
          : tradedNotional.div(trades.length).toDecimalPlaces(2).toString(),
      largestWin:
        wins.length === 0 ? null : Prisma.Decimal.max(...wins).toString(),
      largestLoss:
        losses.length === 0 ? null : Prisma.Decimal.min(...losses).toString(),
      generatedAt: new Date().toISOString(),
    };
  }

  async cancelOrder(
    identity: ClerkIdentity,
    orderId: string,
  ): Promise<OrderSummary> {
    const order = await this.inSerializableTransaction(async (transaction) => {
      const user = await transaction.user.findUnique({
        where: { clerkId: identity.clerkUserId },
        include: { accounts: { where: { type: AccountType.DEMO }, take: 1 } },
      });
      this.assertActiveUser(user);
      const account = user.accounts[0];
      if (!account) this.throwMissingAccount();

      const existing = await transaction.order.findFirst({
        where: { id: orderId, accountId: account.id },
        include: { instrument: true },
      });
      if (!existing) {
        throw new NotFoundException({
          code: 'ORDER_NOT_FOUND',
          message: 'The order could not be found',
        });
      }
      if (existing.status !== 'ACCEPTED') {
        throw new ConflictException({
          code: 'ORDER_NOT_CANCELLABLE',
          message: 'Only accepted orders can be cancelled',
        });
      }
      const cancelled = await transaction.order.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED' },
        include: { instrument: true },
      });
      await transaction.auditEvent.create({
        data: {
          actorUserId: user.id,
          action: 'ORDER_CANCELLED',
          resourceType: 'ORDER',
          resourceId: existing.id,
          metadata: {
            accountId: account.id,
            symbol: existing.instrument.symbol,
            purpose: existing.purpose,
            reason: 'USER_REQUEST',
          },
        },
      });
      return cancelled;
    });
    return serializeOrder(order);
  }

  private async processMarketTick(ticker: MarketTicker) {
    try {
      await this.processPendingOrders(ticker);
      await this.processLiquidations(ticker);
    } catch (error) {
      this.logger.error(
        `Market-tick processing failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async processPendingOrders(ticker: MarketTicker) {
    if (
      ticker.status !== 'LIVE' ||
      this.processingPendingOrders.has(ticker.symbol)
    )
      return;
    this.processingPendingOrders.add(ticker.symbol);
    try {
      const orders = await this.database.client.order.findMany({
        where: {
          status: 'ACCEPTED',
          type: { in: ['LIMIT', 'STOP'] },
          instrument: { symbol: ticker.symbol },
        },
        select: {
          id: true,
          side: true,
          type: true,
          requestedPrice: true,
          stopPrice: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      for (const order of orders) {
        const triggered = shouldTriggerPendingOrder({
          side: order.side,
          type: order.type as 'LIMIT' | 'STOP',
          requestedPrice: order.requestedPrice?.toString() ?? null,
          stopPrice: order.stopPrice?.toString() ?? null,
          bid: ticker.bid,
          ask: ticker.ask,
        });
        if (!triggered) continue;
        try {
          await this.fillAcceptedOrder(order.id, ticker);
        } catch (error) {
          if (error instanceof UnprocessableEntityException) {
            const response = error.getResponse();
            const rejectionCode =
              typeof response === 'object' &&
              response !== null &&
              'code' in response &&
              typeof response.code === 'string'
                ? response.code
                : 'ORDER_RISK_REJECTED';
            await this.database.client.order.updateMany({
              where: { id: order.id, status: 'ACCEPTED' },
              data: {
                status: 'REJECTED',
                rejectionCode,
                triggeredAt: new Date(),
              },
            });
          }
          this.logger.warn(
            `Could not trigger order ${order.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }
    } finally {
      this.processingPendingOrders.delete(ticker.symbol);
    }
  }

  async processLiquidations(ticker: MarketTicker) {
    if (
      ticker.status !== 'LIVE' ||
      this.processingLiquidations.has(ticker.symbol)
    )
      return;
    this.processingLiquidations.add(ticker.symbol);
    try {
      const positions = await this.database.client.position.findMany({
        where: {
          signedQuantity: { not: 0 },
          instrument: { symbol: ticker.symbol },
          account: {
            status: AccountStatus.ACTIVE,
            user: { status: UserStatus.ACTIVE },
          },
        },
        include: {
          account: {
            include: { positions: { include: { instrument: true } } },
          },
        },
      });

      for (const position of positions) {
        const metrics = this.calculatePortfolioRisk(
          position.account.balance,
          position.account.positions,
          ticker,
        );
        if (metrics.riskState !== 'LIQUIDATION') continue;
        try {
          await this.liquidatePosition(position.id, ticker);
        } catch (error) {
          this.logger.error(
            `Could not liquidate position ${position.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }
    } finally {
      this.processingLiquidations.delete(ticker.symbol);
    }
  }

  private async fillAcceptedOrder(orderId: string, ticker: MarketTicker) {
    await this.inSerializableTransaction(async (transaction) => {
      const order = await transaction.order.findUnique({
        where: { id: orderId },
        include: { account: { include: { user: true } }, instrument: true },
      });
      if (!order || order.status !== 'ACCEPTED') return;
      if (
        order.account.status !== AccountStatus.ACTIVE ||
        order.account.user.status !== UserStatus.ACTIVE ||
        order.instrument.status !== InstrumentStatus.ACTIVE
      ) {
        await transaction.order.update({
          where: { id: order.id },
          data: {
            status: 'REJECTED',
            rejectionCode: 'ACCOUNT_OR_MARKET_INACTIVE',
          },
        });
        return;
      }
      await this.fillOrder(
        transaction,
        {
          user: order.account.user,
          account: order.account,
          instrument: order.instrument,
        },
        order,
        ticker,
      );
    });
  }

  private async liquidatePosition(positionId: string, ticker: MarketTicker) {
    await this.inSerializableTransaction(async (transaction) => {
      const position = await transaction.position.findUnique({
        where: { id: positionId },
        include: {
          account: {
            include: {
              user: true,
              positions: { include: { instrument: true } },
            },
          },
          instrument: true,
        },
      });
      if (
        !position ||
        position.signedQuantity.isZero() ||
        position.account.status !== AccountStatus.ACTIVE ||
        position.account.user.status !== UserStatus.ACTIVE
      ) {
        return;
      }

      const metrics = this.calculatePortfolioRisk(
        position.account.balance,
        position.account.positions,
        ticker,
      );
      if (metrics.riskState !== 'LIQUIDATION') return;

      await transaction.order.updateMany({
        where: {
          accountId: position.accountId,
          instrumentId: position.instrumentId,
          status: 'ACCEPTED',
        },
        data: { status: 'CANCELLED' },
      });
      const order = await transaction.order.create({
        data: {
          accountId: position.accountId,
          instrumentId: position.instrumentId,
          clientOrderId: `liquidation:${position.id}:${position.updatedAt.getTime()}`,
          side: position.signedQuantity.isPositive() ? 'SELL' : 'BUY',
          type: 'MARKET',
          quantity: position.signedQuantity.abs(),
          leverage: position.leverage,
          status: 'PENDING',
          purpose: 'LIQUIDATION',
          reduceOnly: true,
        },
      });
      await this.fillOrder(
        transaction,
        {
          user: position.account.user,
          account: position.account,
          instrument: position.instrument,
        },
        order,
        ticker,
      );
    });
  }

  private async fillOrder(
    transaction: Prisma.TransactionClient,
    context: TradeContext,
    order: Prisma.OrderGetPayload<object>,
    ticker: MarketTicker,
  ) {
    const currentPosition = await transaction.position.findUnique({
      where: {
        accountId_instrumentId: {
          accountId: context.account.id,
          instrumentId: context.instrument.id,
        },
      },
    });
    let quantity = order.quantity;
    if (order.reduceOnly) {
      const positionQuantity = currentPosition?.signedQuantity;
      const closesPosition =
        positionQuantity &&
        !positionQuantity.isZero() &&
        (positionQuantity.isPositive()
          ? order.side === 'SELL'
          : order.side === 'BUY');
      if (!closesPosition) {
        await this.cancelProtection(transaction, order);
        return;
      }
      quantity = Prisma.Decimal.min(quantity, positionQuantity.abs());
    }

    const fillPrice = new Prisma.Decimal(
      order.side === 'BUY' ? ticker.ask : ticker.bid,
    );
    const currentSignedQuantity =
      currentPosition?.signedQuantity ?? new Prisma.Decimal(0);
    const signedFill = order.side === 'BUY' ? quantity : quantity.negated();
    const addsToExistingPosition =
      !currentSignedQuantity.isZero() &&
      currentSignedQuantity.isPositive() === signedFill.isPositive();
    if (
      addsToExistingPosition &&
      currentPosition &&
      !currentPosition.leverage.equals(order.leverage)
    ) {
      throw new UnprocessableEntityException({
        code: 'POSITION_LEVERAGE_MISMATCH',
        message: `Use ${currentPosition.leverage.toString()}× leverage while adding to this position`,
      });
    }
    const result = applyFillToPosition({
      signedQuantity: currentSignedQuantity.toString(),
      averageEntryPrice: currentPosition?.averageEntryPrice?.toString() ?? null,
      side: order.side,
      quantity: quantity.toString(),
      fillPrice: fillPrice.toString(),
    });
    const nextSignedQuantity = new Prisma.Decimal(result.signedQuantity);
    const realizedPnlDelta = new Prisma.Decimal(result.realizedPnlDelta);
    const reversesPosition =
      !currentSignedQuantity.isZero() &&
      !nextSignedQuantity.isZero() &&
      currentSignedQuantity.isPositive() !== nextSignedQuantity.isPositive();
    const nextLeverage = nextSignedQuantity.isZero()
      ? new Prisma.Decimal(1)
      : currentPosition && !reversesPosition
        ? currentPosition.leverage
        : order.leverage;
    if (!order.reduceOnly) {
      const otherPositions = await transaction.position.findMany({
        where: {
          accountId: context.account.id,
          instrumentId: { not: context.instrument.id },
          signedQuantity: { not: 0 },
        },
        include: { instrument: true },
      });
      const otherRisk = this.calculateOpenPositionRisk(otherPositions);
      this.validateBuyingPower({
        accountBalance: context.account.balance,
        currentSignedQuantity,
        nextSignedQuantity,
        nextAverageEntryPrice: result.averageEntryPrice
          ? new Prisma.Decimal(result.averageEntryPrice)
          : null,
        fillQuantity: quantity,
        fillPrice,
        side: order.side,
        realizedPnlDelta,
        leverage: nextLeverage,
        otherUnrealizedPnl: otherRisk.unrealizedPnl,
        otherUsedMargin: otherRisk.usedMargin,
      });
    }

    const position = currentPosition
      ? await transaction.position.update({
          where: { id: currentPosition.id },
          data: {
            signedQuantity: nextSignedQuantity,
            averageEntryPrice: result.averageEntryPrice,
            realizedPnl: { increment: realizedPnlDelta },
            leverage: nextLeverage,
          },
        })
      : await transaction.position.create({
          data: {
            accountId: context.account.id,
            instrumentId: context.instrument.id,
            signedQuantity: nextSignedQuantity,
            averageEntryPrice: result.averageEntryPrice,
            realizedPnl: realizedPnlDelta,
            leverage: nextLeverage,
          },
        });
    const filledOrder = await transaction.order.update({
      where: { id: order.id },
      data: {
        status: 'FILLED',
        executedQuantity: quantity,
        averageFillPrice: fillPrice,
        triggeredAt: order.type === 'MARKET' ? null : new Date(),
      },
    });
    const midPrice = new Prisma.Decimal(ticker.bid).plus(ticker.ask).div(2);
    const trade = await transaction.trade.create({
      data: {
        orderId: order.id,
        accountId: context.account.id,
        instrumentId: context.instrument.id,
        positionId: position.id,
        side: order.side,
        price: fillPrice,
        quantity,
        spreadBps: fillPrice.minus(midPrice).abs().div(midPrice).mul(10_000),
        slippageBps: 0,
      },
    });

    if (!realizedPnlDelta.isZero()) {
      const uncappedBalance = context.account.balance.plus(realizedPnlDelta);
      const balanceAfter = Prisma.Decimal.max(0, uncappedBalance);
      const appliedBalanceDelta = balanceAfter.minus(context.account.balance);
      const negativeBalanceProtected = uncappedBalance.isNegative();
      const updatedAccount = await transaction.account.update({
        where: { id: context.account.id },
        data: { balance: balanceAfter },
      });
      await transaction.ledgerEntry.create({
        data: {
          accountId: context.account.id,
          type: 'REALIZED_PNL',
          amount: appliedBalanceDelta,
          balanceAfter: updatedAccount.balance,
          referenceType: 'TRADE',
          referenceId: trade.id,
          idempotencyKey: `trade-realized:${trade.id}`,
          metadata: negativeBalanceProtected
            ? {
                rawRealizedPnl: realizedPnlDelta.toString(),
                protectedAmount: uncappedBalance.abs().toString(),
                negativeBalanceProtection: true,
              }
            : undefined,
        },
      });
      if (negativeBalanceProtected) {
        await transaction.auditEvent.create({
          data: {
            actorUserId: context.user.id,
            action: 'NEGATIVE_BALANCE_PROTECTED',
            resourceType: 'ACCOUNT',
            resourceId: context.account.id,
            metadata: {
              rawRealizedPnl: realizedPnlDelta.toString(),
              protectedAmount: uncappedBalance.abs().toString(),
            },
          },
        });
      }
    }

    if (order.ocoGroupId) {
      await transaction.order.updateMany({
        where: {
          ocoGroupId: order.ocoGroupId,
          id: { not: order.id },
          status: 'ACCEPTED',
        },
        data: { status: 'CANCELLED' },
      });
    }
    if (order.purpose === 'ENTRY') {
      await this.syncProtectiveOrders(
        transaction,
        context,
        filledOrder,
        nextSignedQuantity,
        fillPrice,
        nextLeverage,
      );
    }

    await transaction.auditEvent.create({
      data: {
        actorUserId: context.user.id,
        action: 'ORDER_FILLED',
        resourceType: 'ORDER',
        resourceId: order.id,
        metadata: {
          purpose: order.purpose,
          symbol: context.instrument.symbol,
          side: order.side,
          quantity: quantity.toString(),
          fillPrice: fillPrice.toString(),
        },
      },
    });
    await transaction.outboxEvent.create({
      data: {
        aggregateType: 'ORDER',
        aggregateId: order.id,
        eventType: 'ORDER_FILLED',
        payload: {
          orderId: order.id,
          tradeId: trade.id,
          accountId: context.account.id,
          positionId: position.id,
        },
      },
    });
  }

  private async syncProtectiveOrders(
    transaction: Prisma.TransactionClient,
    context: TradeContext,
    parentOrder: Prisma.OrderGetPayload<object>,
    nextSignedQuantity: Prisma.Decimal,
    fillPrice: Prisma.Decimal,
    leverage: Prisma.Decimal,
  ) {
    const existing = await transaction.order.findMany({
      where: {
        accountId: context.account.id,
        instrumentId: context.instrument.id,
        status: 'ACCEPTED',
        purpose: { in: ['STOP_LOSS', 'TAKE_PROFIT'] },
      },
    });
    await transaction.order.updateMany({
      where: { id: { in: existing.map((item) => item.id) } },
      data: { status: 'CANCELLED' },
    });
    if (nextSignedQuantity.isZero()) return;

    const oldStopLoss = existing.find(
      (item) => item.purpose === 'STOP_LOSS',
    )?.stopPrice;
    const oldTakeProfit = existing.find(
      (item) => item.purpose === 'TAKE_PROFIT',
    )?.requestedPrice;
    const stopLossPrice = parentOrder.stopLossPrice ?? oldStopLoss;
    const takeProfitPrice = parentOrder.takeProfitPrice ?? oldTakeProfit;
    const isLong = nextSignedQuantity.isPositive();
    const validStopLoss =
      stopLossPrice &&
      (isLong
        ? stopLossPrice.lessThan(fillPrice)
        : stopLossPrice.greaterThan(fillPrice));
    const validTakeProfit =
      takeProfitPrice &&
      (isLong
        ? takeProfitPrice.greaterThan(fillPrice)
        : takeProfitPrice.lessThan(fillPrice));
    if (!validStopLoss && !validTakeProfit) return;

    const ocoGroupId = randomUUID();
    const side = isLong ? 'SELL' : 'BUY';
    const quantity = nextSignedQuantity.abs();
    if (validStopLoss) {
      await transaction.order.create({
        data: {
          accountId: context.account.id,
          instrumentId: context.instrument.id,
          clientOrderId: `protection:${parentOrder.id}:stop-loss`,
          side,
          type: 'STOP',
          quantity,
          leverage,
          stopPrice: stopLossPrice,
          status: 'ACCEPTED',
          purpose: 'STOP_LOSS',
          reduceOnly: true,
          parentOrderId: parentOrder.id,
          ocoGroupId,
        },
      });
    }
    if (validTakeProfit) {
      await transaction.order.create({
        data: {
          accountId: context.account.id,
          instrumentId: context.instrument.id,
          clientOrderId: `protection:${parentOrder.id}:take-profit`,
          side,
          type: 'LIMIT',
          quantity,
          leverage,
          requestedPrice: takeProfitPrice,
          status: 'ACCEPTED',
          purpose: 'TAKE_PROFIT',
          reduceOnly: true,
          parentOrderId: parentOrder.id,
          ocoGroupId,
        },
      });
    }
  }

  private async cancelProtection(
    transaction: Prisma.TransactionClient,
    order: Prisma.OrderGetPayload<object>,
  ) {
    await transaction.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' },
    });
    if (order.ocoGroupId) {
      await transaction.order.updateMany({
        where: { ocoGroupId: order.ocoGroupId, status: 'ACCEPTED' },
        data: { status: 'CANCELLED' },
      });
    }
  }

  private async getOrderReceipt(
    identity: ClerkIdentity,
    orderId: string,
  ): Promise<OrderPlacementResponse> {
    const order = await this.database.client.order.findFirst({
      where: {
        id: orderId,
        account: { user: { clerkId: identity.clerkUserId } },
      },
      include: { instrument: true, trades: { take: 1 } },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'The order could not be found',
      });
    }
    const [account, relatedOrders] = await Promise.all([
      this.findAccountWithPositions(identity),
      this.database.client.order.findMany({
        where: { parentOrderId: order.id, status: 'ACCEPTED' },
        include: { instrument: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      order: serializeOrder(order),
      trade: order.trades[0] ? serializeTrade(order.trades[0], order) : null,
      relatedOrders: relatedOrders.map(serializeOrder),
      portfolio: serializePortfolio(
        account,
        this.requirePortfolioTickers(account),
      ),
    };
  }

  private async findAccountWithPositions(
    identity: ClerkIdentity,
  ): Promise<AccountWithPositions> {
    const user = await this.database.client.user.findUnique({
      where: { clerkId: identity.clerkUserId },
      include: {
        accounts: {
          where: { type: AccountType.DEMO, baseCurrency: 'USD' },
          include: { positions: { include: { instrument: true } } },
          take: 1,
        },
      },
    });
    this.assertActiveUser(user);
    const account = user.accounts[0];
    if (!account) this.throwMissingAccount();
    return account;
  }

  private async getTradeContext(
    transaction: Prisma.TransactionClient,
    identity: ClerkIdentity,
    symbol: string,
  ) {
    const user = await transaction.user.findUnique({
      where: { clerkId: identity.clerkUserId },
      include: {
        accounts: {
          where: { type: AccountType.DEMO, baseCurrency: 'USD' },
          take: 1,
        },
      },
    });
    this.assertActiveUser(user);
    const account = user.accounts[0];
    if (!account) this.throwMissingAccount();
    if (account.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException({
        code: 'ACCOUNT_NOT_ACTIVE',
        message: 'The demo account cannot place orders',
      });
    }
    const instrument = await transaction.instrument.findUnique({
      where: { symbol },
    });
    if (!instrument || instrument.status !== InstrumentStatus.ACTIVE) {
      throw new NotFoundException({
        code: 'INSTRUMENT_NOT_TRADABLE',
        message: `${symbol} is not available for trading`,
      });
    }
    return { user, account, instrument };
  }

  private assertActiveUser<T extends { status: UserStatus }>(
    user: T | null,
  ): asserts user is T {
    if (!user) {
      throw new NotFoundException({
        code: 'SESSION_NOT_BOOTSTRAPPED',
        message: 'Bootstrap the session before trading',
      });
    }
    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This Excess account is suspended',
      });
    }
  }

  private throwMissingAccount(): never {
    throw new NotFoundException({
      code: 'DEMO_ACCOUNT_NOT_FOUND',
      message: 'No demo account exists for this user',
    });
  }

  private validateQuantity(
    quantity: Prisma.Decimal,
    instrument: {
      symbol: string;
      quantityPrecision: number;
      lotSize: Prisma.Decimal;
      minimumQuantity: Prisma.Decimal;
    },
  ) {
    if (
      !quantity.isPositive() ||
      quantity.decimalPlaces() > instrument.quantityPrecision ||
      !quantity.mod(instrument.lotSize).isZero() ||
      quantity.lessThan(instrument.minimumQuantity)
    ) {
      throw new BadRequestException({
        code: 'INVALID_ORDER_QUANTITY',
        message: `Quantity does not satisfy the ${instrument.symbol} size rules`,
      });
    }
  }

  private validateLeverage(leverage: number) {
    if (
      !SUPPORTED_LEVERAGE.includes(
        leverage as (typeof SUPPORTED_LEVERAGE)[number],
      )
    ) {
      throw new BadRequestException({
        code: 'INVALID_LEVERAGE',
        message: 'Leverage must be one of 1×, 2×, 5×, or 10×',
      });
    }
  }

  private validateOrderPrices(
    request: OrderPlacementRequest,
    ticker: MarketTicker,
    instrument: {
      symbol: string;
      pricePrecision: number;
      tickSize: Prisma.Decimal;
    },
  ) {
    const executablePrice = new Prisma.Decimal(
      request.side === 'BUY' ? ticker.ask : ticker.bid,
    );
    const primaryPrice =
      request.type === 'LIMIT'
        ? this.validatePrice(request.limitPrice, instrument)
        : request.type === 'STOP'
          ? this.validatePrice(request.stopPrice, instrument)
          : executablePrice;
    if (
      request.type === 'STOP' &&
      (request.side === 'BUY'
        ? primaryPrice.lessThanOrEqualTo(executablePrice)
        : primaryPrice.greaterThanOrEqualTo(executablePrice))
    ) {
      throw new BadRequestException({
        code: 'INVALID_STOP_PRICE',
        message: 'A stop trigger must be beyond the current executable price',
      });
    }

    if (request.stopLossPrice) {
      const stopLoss = this.validatePrice(request.stopLossPrice, instrument);
      const valid =
        request.side === 'BUY'
          ? stopLoss.lessThan(primaryPrice)
          : stopLoss.greaterThan(primaryPrice);
      if (!valid) {
        throw new BadRequestException({
          code: 'INVALID_STOP_LOSS',
          message: 'Stop-loss must be on the loss side of the entry price',
        });
      }
    }
    if (request.takeProfitPrice) {
      const takeProfit = this.validatePrice(
        request.takeProfitPrice,
        instrument,
      );
      const valid =
        request.side === 'BUY'
          ? takeProfit.greaterThan(primaryPrice)
          : takeProfit.lessThan(primaryPrice);
      if (!valid) {
        throw new BadRequestException({
          code: 'INVALID_TAKE_PROFIT',
          message: 'Take-profit must be on the profit side of the entry price',
        });
      }
    }
  }

  private validatePrice(
    value: string,
    instrument: {
      symbol: string;
      pricePrecision: number;
      tickSize: Prisma.Decimal;
    },
  ) {
    const price = new Prisma.Decimal(value);
    if (
      !price.isPositive() ||
      price.decimalPlaces() > instrument.pricePrecision ||
      !price.mod(instrument.tickSize).isZero()
    ) {
      throw new BadRequestException({
        code: 'INVALID_ORDER_PRICE',
        message: `Price does not satisfy the ${instrument.symbol} tick-size rules`,
      });
    }
    return price;
  }

  private validateBuyingPower(input: {
    accountBalance: Prisma.Decimal;
    currentSignedQuantity: Prisma.Decimal;
    nextSignedQuantity: Prisma.Decimal;
    nextAverageEntryPrice: Prisma.Decimal | null;
    fillQuantity: Prisma.Decimal;
    fillPrice: Prisma.Decimal;
    side: 'BUY' | 'SELL';
    realizedPnlDelta: Prisma.Decimal;
    leverage: Prisma.Decimal;
    otherUnrealizedPnl: Prisma.Decimal;
    otherUsedMargin: Prisma.Decimal;
  }) {
    const signedFill =
      input.side === 'BUY' ? input.fillQuantity : input.fillQuantity.negated();
    const opensExposure =
      input.currentSignedQuantity.isZero() ||
      input.currentSignedQuantity.isPositive() === signedFill.isPositive() ||
      input.fillQuantity.greaterThan(input.currentSignedQuantity.abs());
    if (!opensExposure) return;

    const nextBalance = input.accountBalance.plus(input.realizedPnlDelta);
    const nextUnrealized = input.nextAverageEntryPrice
      ? input.fillPrice
          .minus(input.nextAverageEntryPrice)
          .mul(input.nextSignedQuantity)
      : new Prisma.Decimal(0);
    const equity = nextBalance
      .plus(nextUnrealized)
      .plus(input.otherUnrealizedPnl);
    const usedMargin = input.nextSignedQuantity
      .abs()
      .mul(input.fillPrice)
      .div(input.leverage)
      .plus(input.otherUsedMargin);
    if (equity.lessThanOrEqualTo(0) || usedMargin.greaterThan(equity)) {
      throw new UnprocessableEntityException({
        code: 'INSUFFICIENT_BUYING_POWER',
        message: 'This order exceeds the available 1× demo buying power',
      });
    }
  }

  private async inSerializableTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.client.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          !isRetryableTransactionError(error) ||
          attempt === MAX_TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
        await delay(10 * 2 ** (attempt - 1));
      }
    }
    throw new ServiceUnavailableException({
      code: 'ORDER_EXECUTION_UNAVAILABLE',
      message: 'The order could not be processed',
    });
  }

  private requireLiveTicker(symbol: string) {
    const ticker = this.requireTicker(symbol);
    if (ticker.status !== 'LIVE') {
      throw new ServiceUnavailableException({
        code: 'MARKET_NOT_LIVE',
        message: `Order placement requires a live ${symbol} quote`,
      });
    }
    return ticker;
  }

  private requireTicker(symbol: string) {
    const ticker = this.marketData.getCurrentTicker(symbol);
    if (!ticker) {
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: `${symbol} market data is temporarily unavailable`,
      });
    }
    return ticker;
  }

  private requirePortfolioTickers(account: AccountWithPositions) {
    const tickers = new Map<string, MarketTicker>();
    for (const position of account.positions) {
      if (position.signedQuantity.isZero()) continue;
      tickers.set(
        position.instrument.symbol,
        this.requireTicker(position.instrument.symbol),
      );
    }
    return tickers;
  }

  private calculateOpenPositionRisk(
    positions: readonly RiskPosition[],
    overrideTicker?: MarketTicker,
  ) {
    return positions.reduce(
      (risk, position) => {
        if (position.signedQuantity.isZero()) return risk;
        const ticker =
          overrideTicker?.symbol === position.instrument.symbol
            ? overrideTicker
            : this.requireTicker(position.instrument.symbol);
        const unrealizedPnl = position.averageEntryPrice
          ? new Prisma.Decimal(
              calculateUnrealizedPnl({
                averageEntryPrice: position.averageEntryPrice.toString(),
                markPrice: ticker.price,
                signedQuantity: position.signedQuantity.toString(),
              }),
            )
          : new Prisma.Decimal(0);
        return {
          unrealizedPnl: risk.unrealizedPnl.plus(unrealizedPnl),
          usedMargin: risk.usedMargin.plus(
            calculatePositionMargin({
              signedQuantity: position.signedQuantity.toString(),
              markPrice: ticker.price,
              leverage: position.leverage.toString(),
            }),
          ),
        };
      },
      {
        unrealizedPnl: new Prisma.Decimal(0),
        usedMargin: new Prisma.Decimal(0),
      },
    );
  }

  private calculatePortfolioRisk(
    balance: Prisma.Decimal,
    positions: readonly RiskPosition[],
    overrideTicker?: MarketTicker,
  ) {
    const risk = this.calculateOpenPositionRisk(positions, overrideTicker);
    return calculateAccountMetrics({
      balance: balance.toString(),
      unrealizedPnl: risk.unrealizedPnl.toString(),
      usedMargin: risk.usedMargin.toString(),
    });
  }
}
