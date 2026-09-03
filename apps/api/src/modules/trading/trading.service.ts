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
  MarketOrderRequest,
  MarketOrderResponse,
  MarketTicker,
  OpenOrdersResponse,
  OrderPlacementRequest,
  OrderPlacementResponse,
  OrderSummary,
  PortfolioSummary,
  PositionSummary,
  TradeSummary,
} from '@excess/shared-types';
import {
  applyFillToPosition,
  calculateUnrealizedPnl,
  shouldTriggerPendingOrder,
} from '@excess/trading-engine';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import { MarketDataService } from '../market-data/market-data.service.js';

const MAX_TRANSACTION_ATTEMPTS = 5;

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

  return {
    id: position.id,
    symbol: position.instrument.symbol,
    signedQuantity: position.signedQuantity.toString(),
    averageEntryPrice: position.averageEntryPrice?.toString() ?? null,
    markPrice: markPrice.toString(),
    notional: position.signedQuantity.abs().mul(markPrice).toString(),
    realizedPnl: position.realizedPnl.toString(),
    unrealizedPnl: unrealizedPnl.toString(),
    updatedAt: position.updatedAt.toISOString(),
  };
}

function serializePortfolio(
  account: AccountWithPositions,
  ticker: MarketTicker,
): PortfolioSummary {
  const markPrice = new Prisma.Decimal(ticker.price);
  const positions = account.positions
    .filter((position) => !position.signedQuantity.isZero())
    .map((position) => positionSummary(position, markPrice));
  const unrealizedPnl = positions.reduce(
    (total, position) => total.plus(position.unrealizedPnl),
    new Prisma.Decimal(0),
  );

  return {
    account: serializeAccount(account),
    equity: account.balance.plus(unrealizedPnl).toString(),
    unrealizedPnl: unrealizedPnl.toString(),
    positions,
  };
}

@Injectable()
export class TradingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TradingService.name);
  private unsubscribeMarketData: (() => void) | null = null;
  private processingPendingOrders = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly marketData: MarketDataService,
  ) {}

  onApplicationBootstrap() {
    this.unsubscribeMarketData = this.marketData.subscribe((event) => {
      if (event.event === 'market:ticker') {
        void this.processPendingOrders(event.data);
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
    const ticker = this.requireLiveTicker();
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
        this.validateOrderPrices(request, ticker, context.instrument);
        const order = await transaction.order.create({
          data: {
            accountId: context.account.id,
            instrumentId: context.instrument.id,
            clientOrderId: request.clientOrderId,
            side: request.side,
            type: request.type,
            quantity,
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
    const ticker = this.requireTicker();
    const account = await this.findAccountWithPositions(identity);
    return serializePortfolio(account, ticker);
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
      return transaction.order.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED' },
        include: { instrument: true },
      });
    });
    return serializeOrder(order);
  }

  async processPendingOrders(ticker: MarketTicker) {
    if (ticker.status !== 'LIVE' || this.processingPendingOrders) return;
    this.processingPendingOrders = true;
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
            await this.database.client.order.updateMany({
              where: { id: order.id, status: 'ACCEPTED' },
              data: {
                status: 'REJECTED',
                rejectionCode: 'INSUFFICIENT_BUYING_POWER',
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
      this.processingPendingOrders = false;
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
    const result = applyFillToPosition({
      signedQuantity: currentSignedQuantity.toString(),
      averageEntryPrice: currentPosition?.averageEntryPrice?.toString() ?? null,
      side: order.side,
      quantity: quantity.toString(),
      fillPrice: fillPrice.toString(),
    });
    const nextSignedQuantity = new Prisma.Decimal(result.signedQuantity);
    const realizedPnlDelta = new Prisma.Decimal(result.realizedPnlDelta);
    if (!order.reduceOnly) {
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
      });
    }

    const position = currentPosition
      ? await transaction.position.update({
          where: { id: currentPosition.id },
          data: {
            signedQuantity: nextSignedQuantity,
            averageEntryPrice: result.averageEntryPrice,
            realizedPnl: { increment: realizedPnlDelta },
          },
        })
      : await transaction.position.create({
          data: {
            accountId: context.account.id,
            instrumentId: context.instrument.id,
            signedQuantity: nextSignedQuantity,
            averageEntryPrice: result.averageEntryPrice,
            realizedPnl: realizedPnlDelta,
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
      const updatedAccount = await transaction.account.update({
        where: { id: context.account.id },
        data: { balance: { increment: realizedPnlDelta } },
      });
      await transaction.ledgerEntry.create({
        data: {
          accountId: context.account.id,
          type: 'REALIZED_PNL',
          amount: realizedPnlDelta,
          balanceAfter: updatedAccount.balance,
          referenceType: 'TRADE',
          referenceId: trade.id,
          idempotencyKey: `trade-realized:${trade.id}`,
        },
      });
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
    const ticker = this.requireTicker();
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
      portfolio: serializePortfolio(account, ticker),
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
        message: 'Quantity does not satisfy the BTC-USD size rules',
      });
    }
  }

  private validateOrderPrices(
    request: OrderPlacementRequest,
    ticker: MarketTicker,
    instrument: { pricePrecision: number; tickSize: Prisma.Decimal },
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
    instrument: { pricePrecision: number; tickSize: Prisma.Decimal },
  ) {
    const price = new Prisma.Decimal(value);
    if (
      !price.isPositive() ||
      price.decimalPlaces() > instrument.pricePrecision ||
      !price.mod(instrument.tickSize).isZero()
    ) {
      throw new BadRequestException({
        code: 'INVALID_ORDER_PRICE',
        message: 'Price does not satisfy the BTC-USD tick-size rules',
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
    const equity = nextBalance.plus(nextUnrealized);
    const notional = input.nextSignedQuantity.abs().mul(input.fillPrice);
    if (equity.lessThanOrEqualTo(0) || notional.greaterThan(equity)) {
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

  private requireLiveTicker() {
    const ticker = this.requireTicker();
    if (ticker.status !== 'LIVE') {
      throw new ServiceUnavailableException({
        code: 'MARKET_NOT_LIVE',
        message: 'Order placement requires a live BTC-USD quote',
      });
    }
    return ticker;
  }

  private requireTicker() {
    const ticker = this.marketData.getCurrentTicker();
    if (!ticker) {
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'BTC-USD market data is temporarily unavailable',
      });
    }
    return ticker;
  }
}
