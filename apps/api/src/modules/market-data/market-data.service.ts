import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@excess/database';
import type {
  CandleHistoryResponse,
  MarketCandle,
  MarketDataStatus,
  MarketInstrumentSummary,
  MarketStreamEvent,
  MarketTicker,
} from '@excess/shared-types';

import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../redis/redis.service.js';
import {
  CANDLE_GRANULARITY,
  MARKET_DATA_PROVIDER,
  MARKET_SYMBOL,
  type MarketDataProvider,
  type MarketProviderEvent,
  type ProviderTicker,
} from './market-data.types.js';

const CANDLES_CACHE_KEY = `market:${MARKET_SYMBOL}:candles:${CANDLE_GRANULARITY}`;
const TICKER_CACHE_KEY = `market:${MARKET_SYMBOL}:ticker`;
const MAX_CANDLES = 300;

@Injectable()
export class MarketDataService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MarketDataService.name);
  private readonly listeners = new Set<(event: MarketStreamEvent) => void>();
  private candles: MarketCandle[] = [];
  private ticker: MarketTicker | null = null;
  private status: MarketDataStatus = 'OFFLINE';
  private unsubscribeProvider: (() => void) | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    @Inject(MARKET_DATA_PROVIDER)
    private readonly provider: MarketDataProvider,
  ) {}

  async onApplicationBootstrap() {
    await this.ensureInstrument();
    this.unsubscribeProvider = this.provider.subscribe((event) => {
      void this.handleProviderEvent(event);
    });

    await Promise.allSettled([this.hydrateCandles(), this.hydrateTicker()]);
    await this.provider.start();
  }

  async onModuleDestroy() {
    this.unsubscribeProvider?.();
    await this.provider.stop();
  }

  subscribe(listener: (event: MarketStreamEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getCurrentTicker() {
    return this.ticker;
  }

  async getInstrument(symbol: string): Promise<MarketInstrumentSummary> {
    this.assertSupportedSymbol(symbol);
    const instrument = await this.database.client.instrument.findUnique({
      where: { symbol: MARKET_SYMBOL },
    });
    if (!instrument) {
      throw new NotFoundException({
        code: 'INSTRUMENT_NOT_FOUND',
        message: `Instrument ${symbol} is not available`,
      });
    }

    if (!this.ticker) {
      await this.hydrateTicker();
    }
    if (!this.ticker) {
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'BTC-USD market data is temporarily unavailable',
      });
    }

    return {
      symbol: instrument.symbol,
      displayName: `${instrument.baseCurrency}/${instrument.quoteCurrency}`,
      baseCurrency: instrument.baseCurrency,
      quoteCurrency: instrument.quoteCurrency,
      pricePrecision: instrument.pricePrecision,
      quantityPrecision: instrument.quantityPrecision,
      tickSize: instrument.tickSize.toString(),
      lotSize: instrument.lotSize.toString(),
      minimumQuantity: instrument.minimumQuantity.toString(),
      status: instrument.status,
      ticker: this.ticker,
    };
  }

  async getCandles(
    symbol: string,
    limit: number,
  ): Promise<CandleHistoryResponse> {
    this.assertSupportedSymbol(symbol);
    if (this.candles.length === 0) {
      await this.hydrateCandles();
    }
    if (this.candles.length === 0) {
      throw new ServiceUnavailableException({
        code: 'CANDLE_HISTORY_UNAVAILABLE',
        message: 'BTC-USD candle history is temporarily unavailable',
      });
    }

    return {
      symbol: MARKET_SYMBOL,
      granularity: CANDLE_GRANULARITY,
      items: this.candles.slice(-limit),
      source: this.provider.source,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async ensureInstrument() {
    await this.database.client.instrument.upsert({
      where: { symbol: MARKET_SYMBOL },
      create: {
        symbol: MARKET_SYMBOL,
        baseCurrency: 'BTC',
        quoteCurrency: 'USD',
        pricePrecision: 2,
        quantityPrecision: 8,
        tickSize: new Prisma.Decimal('0.01'),
        lotSize: new Prisma.Decimal('0.00000001'),
        minimumQuantity: new Prisma.Decimal('0.00000001'),
        defaultSpreadBps: new Prisma.Decimal('0'),
      },
      update: {},
    });
  }

  private assertSupportedSymbol(symbol: string) {
    if (symbol.toUpperCase() !== MARKET_SYMBOL) {
      throw new NotFoundException({
        code: 'INSTRUMENT_NOT_FOUND',
        message: `Instrument ${symbol} is not available`,
      });
    }
  }

  private async hydrateCandles() {
    const cached = await this.redis.getJson<MarketCandle[]>(CANDLES_CACHE_KEY);
    if (cached?.length) {
      this.candles = cached.slice(-MAX_CANDLES);
      return;
    }

    try {
      this.candles = await this.provider.fetchCandles(MAX_CANDLES);
      await this.redis.setJson(CANDLES_CACHE_KEY, this.candles, 60);
    } catch (error) {
      this.logger.warn(
        `Could not hydrate candle history: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async hydrateTicker() {
    const cached = await this.redis.getJson<MarketTicker>(TICKER_CACHE_KEY);
    if (cached) {
      this.ticker = {
        ...cached,
        source: this.provider.source,
        status: this.provider.status,
      };
      return;
    }

    try {
      this.ticker = this.toTicker(await this.provider.fetchTicker());
      await this.redis.setJson(TICKER_CACHE_KEY, this.ticker, 15);
    } catch (error) {
      this.logger.warn(
        `Could not hydrate ticker: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async handleProviderEvent(event: MarketProviderEvent) {
    if (event.type === 'status') {
      this.status = event.status;
      if (this.ticker) {
        this.ticker = { ...this.ticker, status: event.status };
      }
      this.broadcast({
        event: 'market:status',
        data: { symbol: MARKET_SYMBOL, status: event.status },
      });
      return;
    }

    if (event.type === 'ticker') {
      this.ticker = this.toTicker(event.ticker);
      await this.redis.setJson(TICKER_CACHE_KEY, this.ticker, 15);
      this.broadcast({ event: 'market:ticker', data: this.ticker });
      return;
    }

    const latestTime = this.candles.at(-1)?.time ?? 0;
    const candleIndex = this.candles.findIndex(
      (candle) => candle.time === event.candle.time,
    );
    if (candleIndex >= 0) {
      this.candles[candleIndex] = event.candle;
    } else {
      this.candles.push(event.candle);
      this.candles.sort((left, right) => left.time - right.time);
      this.candles = this.candles.slice(-MAX_CANDLES);
    }
    await this.redis.setJson(CANDLES_CACHE_KEY, this.candles, 60);
    if (event.candle.time >= latestTime) {
      this.broadcast({
        event: 'market:candle',
        data: { symbol: event.symbol, candle: event.candle },
      });
    }
  }

  private toTicker(ticker: ProviderTicker): MarketTicker {
    return {
      ...ticker,
      status: this.status === 'OFFLINE' ? this.provider.status : this.status,
      source: this.provider.source,
    };
  }

  private broadcast(event: MarketStreamEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
