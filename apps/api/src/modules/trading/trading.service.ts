import { setTimeout as delay } from 'node:timers/promises';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AccountStatus,
  AccountType,
  InstrumentStatus,
  Prisma,
  UserStatus,
} from '@excess/database';
import type {
  DemoAccountSummary,
  MarketOrderRequest,
  MarketOrderResponse,
  MarketTicker,
  OrderSummary,
  PortfolioSummary,
  PositionSummary,
  TradeSummary,
} from '@excess/shared-types';
import {
  applyFillToPosition,
  calculateUnrealizedPnl,
} from '@excess/trading-engine';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import { MarketDataService } from '../market-data/market-data.service.js';

const MAX_TRANSACTION_ATTEMPTS = 5;

type AccountWithPositions = Prisma.AccountGetPayload<{
  include: { positions: { include: { instrument: true } } };
}>;

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
export class TradingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly marketData: MarketDataService,
  ) {}

  async placeMarketOrder(
    identity: ClerkIdentity,
    request: MarketOrderRequest,
  ): Promise<MarketOrderResponse> {
    const ticker = this.requireLiveTicker();
    const fillPrice = new Prisma.Decimal(
      request.side === 'BUY' ? ticker.ask : ticker.bid,
    );
    let orderId: string | null = null;

    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        orderId = await this.database.client.$transaction(
          async (transaction) => {
            const user = await transaction.user.findUnique({
              where: { clerkId: identity.clerkUserId },
              include: {
                accounts: {
                  where: { type: AccountType.DEMO, baseCurrency: 'USD' },
                  take: 1,
                },
              },
            });
            if (!user) {
              throw new NotFoundException({
                code: 'SESSION_NOT_BOOTSTRAPPED',
                message: 'Bootstrap the session before placing an order',
              });
            }
            if (user.status === UserStatus.SUSPENDED) {
              throw new ForbiddenException({
                code: 'ACCOUNT_SUSPENDED',
                message: 'This Excess account is suspended',
              });
            }

            const account = user.accounts[0];
            if (!account) {
              throw new NotFoundException({
                code: 'DEMO_ACCOUNT_NOT_FOUND',
                message: 'No demo account exists for this user',
              });
            }
            if (account.status !== AccountStatus.ACTIVE) {
              throw new ForbiddenException({
                code: 'ACCOUNT_NOT_ACTIVE',
                message: 'The demo account cannot place orders',
              });
            }

            const duplicate = await transaction.order.findUnique({
              where: {
                accountId_clientOrderId: {
                  accountId: account.id,
                  clientOrderId: request.clientOrderId,
                },
              },
              select: { id: true },
            });
            if (duplicate) return duplicate.id;

            const instrument = await transaction.instrument.findUnique({
              where: { symbol: request.symbol },
            });
            if (!instrument || instrument.status !== InstrumentStatus.ACTIVE) {
              throw new NotFoundException({
                code: 'INSTRUMENT_NOT_TRADABLE',
                message: `${request.symbol} is not available for trading`,
              });
            }

            const quantity = new Prisma.Decimal(request.quantity);
            this.validateQuantity(quantity, instrument);
            const currentPosition = await transaction.position.findUnique({
              where: {
                accountId_instrumentId: {
                  accountId: account.id,
                  instrumentId: instrument.id,
                },
              },
            });
            const currentSignedQuantity =
              currentPosition?.signedQuantity ?? new Prisma.Decimal(0);
            const result = applyFillToPosition({
              signedQuantity: currentSignedQuantity.toString(),
              averageEntryPrice:
                currentPosition?.averageEntryPrice?.toString() ?? null,
              side: request.side,
              quantity: quantity.toString(),
              fillPrice: fillPrice.toString(),
            });
            const nextSignedQuantity = new Prisma.Decimal(
              result.signedQuantity,
            );
            const realizedPnlDelta = new Prisma.Decimal(
              result.realizedPnlDelta,
            );
            this.validateBuyingPower({
              accountBalance: account.balance,
              currentSignedQuantity,
              nextSignedQuantity,
              nextAverageEntryPrice: result.averageEntryPrice
                ? new Prisma.Decimal(result.averageEntryPrice)
                : null,
              fillQuantity: quantity,
              fillPrice,
              side: request.side,
              realizedPnlDelta,
            });

            const position = currentPosition
              ? await transaction.position.update({
                  where: { id: currentPosition.id },
                  data: {
                    signedQuantity: nextSignedQuantity,
                    averageEntryPrice: result.averageEntryPrice,
                    realizedPnl: {
                      increment: realizedPnlDelta,
                    },
                  },
                })
              : await transaction.position.create({
                  data: {
                    accountId: account.id,
                    instrumentId: instrument.id,
                    signedQuantity: nextSignedQuantity,
                    averageEntryPrice: result.averageEntryPrice,
                    realizedPnl: realizedPnlDelta,
                  },
                });

            const midPrice = new Prisma.Decimal(ticker.bid)
              .plus(ticker.ask)
              .div(2);
            const spreadBps = fillPrice
              .minus(midPrice)
              .abs()
              .div(midPrice)
              .mul(10_000);
            const order = await transaction.order.create({
              data: {
                accountId: account.id,
                instrumentId: instrument.id,
                clientOrderId: request.clientOrderId,
                side: request.side,
                type: 'MARKET',
                quantity,
                executedQuantity: quantity,
                averageFillPrice: fillPrice,
                status: 'FILLED',
              },
            });
            const trade = await transaction.trade.create({
              data: {
                orderId: order.id,
                accountId: account.id,
                instrumentId: instrument.id,
                positionId: position.id,
                side: request.side,
                price: fillPrice,
                quantity,
                spreadBps,
                slippageBps: 0,
              },
            });

            if (!realizedPnlDelta.isZero()) {
              const updatedAccount = await transaction.account.update({
                where: { id: account.id },
                data: { balance: { increment: realizedPnlDelta } },
              });
              await transaction.ledgerEntry.create({
                data: {
                  accountId: account.id,
                  type: 'REALIZED_PNL',
                  amount: realizedPnlDelta,
                  balanceAfter: updatedAccount.balance,
                  referenceType: 'TRADE',
                  referenceId: trade.id,
                  idempotencyKey: `trade-realized:${trade.id}`,
                },
              });
            }

            await Promise.all([
              transaction.auditEvent.create({
                data: {
                  actorUserId: user.id,
                  action: 'MARKET_ORDER_FILLED',
                  resourceType: 'ORDER',
                  resourceId: order.id,
                  metadata: {
                    symbol: instrument.symbol,
                    side: request.side,
                    quantity: quantity.toString(),
                    fillPrice: fillPrice.toString(),
                  },
                },
              }),
              transaction.outboxEvent.create({
                data: {
                  aggregateType: 'ORDER',
                  aggregateId: order.id,
                  eventType: 'ORDER_FILLED',
                  payload: {
                    orderId: order.id,
                    tradeId: trade.id,
                    accountId: account.id,
                    positionId: position.id,
                  },
                },
              }),
            ]);

            return order.id;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
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

    if (!orderId) {
      throw new ServiceUnavailableException({
        code: 'ORDER_EXECUTION_UNAVAILABLE',
        message: 'The market order could not be executed',
      });
    }
    return this.getOrderReceipt(identity, orderId);
  }

  async getPortfolio(identity: ClerkIdentity): Promise<PortfolioSummary> {
    const ticker = this.requireTicker();
    const account = await this.findAccountWithPositions(identity);
    return serializePortfolio(account, ticker);
  }

  private async getOrderReceipt(
    identity: ClerkIdentity,
    orderId: string,
  ): Promise<MarketOrderResponse> {
    const ticker = this.requireTicker();
    const order = await this.database.client.order.findFirst({
      where: {
        id: orderId,
        account: { user: { clerkId: identity.clerkUserId } },
      },
      include: { instrument: true, trades: { take: 1 } },
    });
    if (!order || !order.trades[0]) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'The filled order could not be found',
      });
    }
    const account = await this.findAccountWithPositions(identity);
    const trade = order.trades[0];
    const orderSummary: OrderSummary = {
      id: order.id,
      clientOrderId: order.clientOrderId,
      symbol: order.instrument.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity.toString(),
      executedQuantity: order.executedQuantity.toString(),
      averageFillPrice: order.averageFillPrice?.toString() ?? null,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
    };
    const tradeSummary: TradeSummary = {
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

    return {
      order: orderSummary,
      trade: tradeSummary,
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
    if (!user) {
      throw new NotFoundException({
        code: 'SESSION_NOT_BOOTSTRAPPED',
        message: 'Bootstrap the session before requesting a portfolio',
      });
    }
    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This Excess account is suspended',
      });
    }
    const account = user.accounts[0];
    if (!account) {
      throw new NotFoundException({
        code: 'DEMO_ACCOUNT_NOT_FOUND',
        message: 'No demo account exists for this user',
      });
    }
    return account;
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

  private requireLiveTicker() {
    const ticker = this.requireTicker();
    if (ticker.status !== 'LIVE') {
      throw new ServiceUnavailableException({
        code: 'MARKET_NOT_LIVE',
        message: 'Market orders require a live BTC-USD quote',
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
