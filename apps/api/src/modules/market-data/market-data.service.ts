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
  MarketInstrumentsResponse,
  MarketSymbol,
  MarketStreamEvent,
  MarketTicker,
} from '@excess/shared-types';

import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../redis/redis.service.js';
import {
  CANDLE_GRANULARITY,
  MARKET_DATA_PROVIDER,
  MARKET_INSTRUMENTS,
  MARKET_SYMBOLS,
  isMarketSymbol,
  type MarketDataProvider,
  type MarketProviderEvent,
  type ProviderTicker,
} from './market-data.types.js';

const MAX_CANDLES = 300;

const candlesCacheKey = (symbol: MarketSymbol) =>
  `market:${symbol}:candles:${CANDLE_GRANULARITY}`;
const tickerCacheKey = (symbol: MarketSymbol) => `market:${symbol}:ticker`;

@Injectable()
export class MarketDataService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MarketDataService.name);
  private readonly listeners = new Set<(event: MarketStreamEvent) => void>();
  private readonly candles = new Map<MarketSymbol, MarketCandle[]>();
  private readonly tickers = new Map<MarketSymbol, MarketTicker>();
  private status: MarketDataStatus = 'OFFLINE';
  private unsubscribeProvider: (() => void) | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    @Inject(MARKET_DATA_PROVIDER)
    private readonly provider: MarketDataProvider,
  ) {}

  async onApplicationBootstrap() {
    await this.ensureInstruments();
    this.unsubscribeProvider = this.provider.subscribe((event) => {
      void this.handleProviderEvent(event);
    });

    await Promise.allSettled(
      MARKET_SYMBOLS.flatMap((symbol) => [
        this.hydrateCandles(symbol),
        this.hydrateTicker(symbol),
      ]),
    );
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

  getCurrentTicker(symbol: string = 'BTC-USD') {
    const normalizedSymbol = this.assertSupportedSymbol(symbol);
    return this.tickers.get(normalizedSymbol) ?? null;
  }

  getCurrentTickers() {
    return MARKET_SYMBOLS.flatMap((symbol) => {
      const ticker = this.tickers.get(symbol);
      return ticker ? [ticker] : [];
    });
  }

  isReady(maximumAgeMilliseconds = 30_000) {
    return MARKET_SYMBOLS.every((symbol) => {
      const ticker = this.tickers.get(symbol);
      if (!ticker || ticker.status !== 'LIVE') return false;
      const updatedAt = Date.parse(ticker.updatedAt);
      return (
        Number.isFinite(updatedAt) &&
        Date.now() - updatedAt <= maximumAgeMilliseconds
      );
    });
  }

  async getInstrument(symbol: string): Promise<MarketInstrumentSummary> {
    const normalizedSymbol = this.assertSupportedSymbol(symbol);
    const instrument = await this.database.client.instrument.findUnique({
      where: { symbol: normalizedSymbol },
    });
    if (!instrument) {
      throw new NotFoundException({
        code: 'INSTRUMENT_NOT_FOUND',
        message: `Instrument ${symbol} is not available`,
      });
    }

    if (!this.tickers.has(normalizedSymbol)) {
      await this.hydrateTicker(normalizedSymbol);
    }
    const ticker = this.tickers.get(normalizedSymbol);
    if (!ticker) {
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: `${normalizedSymbol} market data is temporarily unavailable`,
      });
    }

    return {
      symbol: normalizedSymbol,
      displayName: `${instrument.baseCurrency}/${instrument.quoteCurrency}`,
      baseCurrency: instrument.baseCurrency,
      quoteCurrency: instrument.quoteCurrency,
      pricePrecision: instrument.pricePrecision,
      quantityPrecision: instrument.quantityPrecision,
      tickSize: instrument.tickSize.toString(),
      lotSize: instrument.lotSize.toString(),
      minimumQuantity: instrument.minimumQuantity.toString(),
      status: instrument.status,
      ticker,
    };
  }

  async listInstruments(): Promise<MarketInstrumentsResponse> {
    return {
      items: await Promise.all(
        MARKET_SYMBOLS.map((symbol) => this.getInstrument(symbol)),
      ),
    };
  }

  async getCandles(
    symbol: string,
    limit: number,
  ): Promise<CandleHistoryResponse> {
    const normalizedSymbol = this.assertSupportedSymbol(symbol);
    if ((this.candles.get(normalizedSymbol)?.length ?? 0) === 0) {
      await this.hydrateCandles(normalizedSymbol);
    }
    const candles = this.candles.get(normalizedSymbol) ?? [];
    if (candles.length === 0) {
      throw new ServiceUnavailableException({
        code: 'CANDLE_HISTORY_UNAVAILABLE',
        message: `${normalizedSymbol} candle history is temporarily unavailable`,
      });
    }

    return {
      symbol: normalizedSymbol,
      granularity: CANDLE_GRANULARITY,
      items: candles.slice(-limit),
      source: this.provider.source,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async ensureInstruments() {
    await Promise.all(
      MARKET_SYMBOLS.map((symbol) => {
        const specification = MARKET_INSTRUMENTS[symbol];
        return this.database.client.instrument.upsert({
          where: { symbol },
          create: {
            symbol,
            baseCurrency: specification.baseCurrency,
            quoteCurrency: specification.quoteCurrency,
            pricePrecision: specification.pricePrecision,
            quantityPrecision: specification.quantityPrecision,
            tickSize: new Prisma.Decimal(specification.tickSize),
            lotSize: new Prisma.Decimal(specification.lotSize),
            minimumQuantity: new Prisma.Decimal(specification.minimumQuantity),
            defaultSpreadBps: new Prisma.Decimal(
              specification.defaultSpreadBps,
            ),
          },
          update: {},
        });
      }),
    );
  }

  private assertSupportedSymbol(symbol: string): MarketSymbol {
    const normalizedSymbol = symbol.toUpperCase();
    if (!isMarketSymbol(normalizedSymbol)) {
      throw new NotFoundException({
        code: 'INSTRUMENT_NOT_FOUND',
        message: `Instrument ${symbol} is not available`,
      });
    }
    return normalizedSymbol;
  }

  private async hydrateCandles(symbol: MarketSymbol) {
    const cacheKey = candlesCacheKey(symbol);
    const cached = await this.redis.getJson<MarketCandle[]>(cacheKey);
    if (cached?.length) {
      this.candles.set(symbol, cached.slice(-MAX_CANDLES));
      return;
    }

    try {
      const candles = await this.provider.fetchCandles(symbol, MAX_CANDLES);
      this.candles.set(symbol, candles);
      await this.redis.setJson(cacheKey, candles, 60);
    } catch (error) {
      this.logger.warn(
        `Could not hydrate ${symbol} candle history: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async hydrateTicker(symbol: MarketSymbol) {
    const cacheKey = tickerCacheKey(symbol);
    const cached = await this.redis.getJson<MarketTicker>(cacheKey);
    if (cached) {
      this.tickers.set(symbol, {
        ...cached,
        source: this.provider.source,
        status: this.provider.status,
      });
      return;
    }

    try {
      const ticker = this.toTicker(await this.provider.fetchTicker(symbol));
      this.tickers.set(symbol, ticker);
      await this.redis.setJson(cacheKey, ticker, 15);
    } catch (error) {
      this.logger.warn(
        `Could not hydrate ${symbol} ticker: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async handleProviderEvent(event: MarketProviderEvent) {
    if (event.type === 'status') {
      this.status = event.status;
      for (const symbol of MARKET_SYMBOLS) {
        const ticker = this.tickers.get(symbol);
        if (ticker) {
          this.tickers.set(symbol, { ...ticker, status: event.status });
        }
        this.broadcast({
          event: 'market:status',
          data: { symbol, status: event.status },
        });
      }
      return;
    }

    if (event.type === 'ticker') {
      const ticker = this.toTicker(event.ticker);
      this.tickers.set(ticker.symbol, ticker);
      await this.redis.setJson(tickerCacheKey(ticker.symbol), ticker, 15);
      this.broadcast({ event: 'market:ticker', data: ticker });
      return;
    }

    let candles = this.candles.get(event.symbol) ?? [];
    const latestTime = candles.at(-1)?.time ?? 0;
    const candleIndex = candles.findIndex(
      (candle) => candle.time === event.candle.time,
    );
    if (candleIndex >= 0) {
      candles[candleIndex] = event.candle;
    } else {
      candles.push(event.candle);
      candles.sort((left, right) => left.time - right.time);
      candles = candles.slice(-MAX_CANDLES);
    }
    this.candles.set(event.symbol, candles);
    await this.redis.setJson(candlesCacheKey(event.symbol), candles, 60);
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
