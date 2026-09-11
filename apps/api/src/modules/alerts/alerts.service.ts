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
} from '@nestjs/common';
import {
  InstrumentStatus,
  Prisma,
  UserStatus,
  type OutboxStatus,
} from '@excess/database';
import type {
  CreatePriceAlertRequest,
  MarketTicker,
  PriceAlertsResponse,
  PriceAlertSummary,
} from '@excess/shared-types';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
import { MarketDataService } from '../market-data/market-data.service.js';

const MAX_ACTIVE_ALERTS = 20;
const MAX_TRANSACTION_ATTEMPTS = 5;

function isRetryableTransactionError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002')
  );
}

type AlertWithInstrument = Prisma.PriceAlertGetPayload<{
  include: { instrument: true };
}>;

function serializeAlert(
  alert: AlertWithInstrument,
  deliveryStatus: OutboxStatus | null = null,
): PriceAlertSummary {
  return {
    id: alert.id,
    symbol: alert.instrument.symbol,
    direction: alert.direction,
    targetPrice: alert.targetPrice.toString(),
    status: alert.status,
    deliveryStatus,
    triggeredPrice: alert.triggeredPrice?.toString() ?? null,
    triggeredAt: alert.triggeredAt?.toISOString() ?? null,
    createdAt: alert.createdAt.toISOString(),
    updatedAt: alert.updatedAt.toISOString(),
  };
}

@Injectable()
export class AlertsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AlertsService.name);
  private unsubscribeMarketData: (() => void) | null = null;
  private readonly processingTickers = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly marketData: MarketDataService,
  ) {}

  onApplicationBootstrap() {
    this.unsubscribeMarketData = this.marketData.subscribe((event) => {
      if (event.event === 'market:ticker') {
        void this.processTicker(event.data).catch((error: unknown) => {
          this.logger.error(
            `Price-alert processing failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        });
      }
    });
  }

  onModuleDestroy() {
    this.unsubscribeMarketData?.();
  }

  async createAlert(
    identity: ClerkIdentity,
    request: CreatePriceAlertRequest,
  ): Promise<PriceAlertSummary> {
    const ticker = this.requireTicker(request.symbol);
    const user = await this.requireActiveUser(identity);
    const instrument = await this.database.client.instrument.findUnique({
      where: { symbol: request.symbol },
    });
    if (!instrument || instrument.status !== InstrumentStatus.ACTIVE) {
      throw new NotFoundException({
        code: 'INSTRUMENT_NOT_TRADABLE',
        message: `${request.symbol} is not available for alerts`,
      });
    }

    const targetPrice = new Prisma.Decimal(request.targetPrice);
    if (
      !targetPrice.isPositive() ||
      targetPrice.decimalPlaces() > instrument.pricePrecision ||
      !targetPrice.mod(instrument.tickSize).isZero()
    ) {
      throw new BadRequestException({
        code: 'INVALID_ALERT_PRICE',
        message: `Alert price does not satisfy the ${request.symbol} tick-size rules`,
      });
    }
    const currentPrice = new Prisma.Decimal(ticker.price);
    const targetIsAhead =
      request.direction === 'ABOVE'
        ? targetPrice.greaterThan(currentPrice)
        : targetPrice.lessThan(currentPrice);
    if (!targetIsAhead) {
      throw new BadRequestException({
        code: 'ALERT_TARGET_ALREADY_REACHED',
        message: `Choose a price ${request.direction === 'ABOVE' ? 'above' : 'below'} the current market`,
      });
    }

    const alert = await this.inSerializableTransaction(async (transaction) => {
      const activeCount = await transaction.priceAlert.count({
        where: { userId: user.id, status: 'ACTIVE' },
      });
      if (activeCount >= MAX_ACTIVE_ALERTS) {
        throw new BadRequestException({
          code: 'ACTIVE_ALERT_LIMIT_REACHED',
          message: `A maximum of ${MAX_ACTIVE_ALERTS} active alerts is allowed`,
        });
      }
      return transaction.priceAlert.create({
        data: {
          userId: user.id,
          instrumentId: instrument.id,
          direction: request.direction,
          targetPrice,
        },
        include: { instrument: true },
      });
    });
    return serializeAlert(alert);
  }

  async listAlerts(identity: ClerkIdentity): Promise<PriceAlertsResponse> {
    const user = await this.requireActiveUser(identity);
    const alerts = await this.database.client.priceAlert.findMany({
      where: { userId: user.id },
      include: { instrument: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    const deliveries = await this.database.client.outboxEvent.findMany({
      where: {
        aggregateType: 'PRICE_ALERT',
        aggregateId: { in: alerts.map((alert) => alert.id) },
        eventType: 'PRICE_ALERT_TRIGGERED',
      },
      select: { aggregateId: true, status: true },
    });
    const deliveryByAlert = new Map(
      deliveries.map((delivery) => [delivery.aggregateId, delivery.status]),
    );
    return {
      items: alerts.map((alert) =>
        serializeAlert(alert, deliveryByAlert.get(alert.id) ?? null),
      ),
    };
  }

  async cancelAlert(
    identity: ClerkIdentity,
    alertId: string,
  ): Promise<PriceAlertSummary> {
    const user = await this.requireActiveUser(identity);
    const existing = await this.database.client.priceAlert.findFirst({
      where: { id: alertId, userId: user.id },
      include: { instrument: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'PRICE_ALERT_NOT_FOUND',
        message: 'The price alert could not be found',
      });
    }
    if (existing.status !== 'ACTIVE') {
      throw new ConflictException({
        code: 'PRICE_ALERT_NOT_CANCELLABLE',
        message: 'Only active alerts can be cancelled',
      });
    }
    const alert = await this.database.client.priceAlert.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED' },
      include: { instrument: true },
    });
    return serializeAlert(alert);
  }

  async processTicker(ticker: MarketTicker) {
    if (ticker.status !== 'LIVE' || this.processingTickers.has(ticker.symbol))
      return;
    this.processingTickers.add(ticker.symbol);
    try {
      const price = new Prisma.Decimal(ticker.price);
      const alerts = await this.database.client.priceAlert.findMany({
        where: {
          status: 'ACTIVE',
          instrument: { symbol: ticker.symbol },
          OR: [
            { direction: 'ABOVE', targetPrice: { lte: price } },
            { direction: 'BELOW', targetPrice: { gte: price } },
          ],
        },
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const alert of alerts) {
        try {
          await this.triggerAlert(alert.id, price, ticker.updatedAt);
        } catch (error) {
          this.logger.error(
            `Could not trigger alert ${alert.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }
    } finally {
      this.processingTickers.delete(ticker.symbol);
    }
  }

  private async triggerAlert(
    alertId: string,
    price: Prisma.Decimal,
    triggeredAt: string,
  ) {
    await this.inSerializableTransaction(async (transaction) => {
      const updated = await transaction.priceAlert.updateMany({
        where: { id: alertId, status: 'ACTIVE' },
        data: {
          status: 'TRIGGERED',
          triggeredPrice: price,
          triggeredAt: new Date(triggeredAt),
        },
      });
      if (updated.count === 0) return;
      const alert = await transaction.priceAlert.findUniqueOrThrow({
        where: { id: alertId },
        include: { instrument: true },
      });
      await Promise.all([
        transaction.outboxEvent.create({
          data: {
            aggregateType: 'PRICE_ALERT',
            aggregateId: alert.id,
            eventType: 'PRICE_ALERT_TRIGGERED',
            payload: {
              alertId: alert.id,
              userId: alert.userId,
              symbol: alert.instrument.symbol,
              direction: alert.direction,
              targetPrice: alert.targetPrice.toString(),
              triggeredPrice: price.toString(),
            },
          },
        }),
        transaction.auditEvent.create({
          data: {
            actorUserId: alert.userId,
            action: 'PRICE_ALERT_TRIGGERED',
            resourceType: 'PRICE_ALERT',
            resourceId: alert.id,
            metadata: {
              symbol: alert.instrument.symbol,
              direction: alert.direction,
              targetPrice: alert.targetPrice.toString(),
              triggeredPrice: price.toString(),
            },
          },
        }),
      ]);
    });
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
    throw new Error('Price alert transaction attempts exhausted');
  }

  private async requireActiveUser(identity: ClerkIdentity) {
    const user = await this.database.client.user.findUnique({
      where: { clerkId: identity.clerkUserId },
    });
    if (!user) {
      throw new NotFoundException({
        code: 'SESSION_NOT_BOOTSTRAPPED',
        message: 'Bootstrap the session before managing alerts',
      });
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This Excess account is suspended',
      });
    }
    return user;
  }

  private requireTicker(symbol: string) {
    const ticker = this.marketData.getCurrentTicker(symbol);
    if (!ticker || ticker.status !== 'LIVE') {
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: `A live ${symbol} price is required to create an alert`,
      });
    }
    return ticker;
  }
}
