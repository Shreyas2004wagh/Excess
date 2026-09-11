import { Injectable } from '@nestjs/common';
import type {
  MarketCandle,
  MarketDataStatus,
  MarketSymbol,
} from '@excess/shared-types';

import {
  CANDLE_GRANULARITY,
  MARKET_SYMBOLS,
  type MarketDataProvider,
  type MarketProviderEvent,
  type ProviderTicker,
} from './market-data.types.js';

const mockMarkets: Record<
  MarketSymbol,
  { basePrice: number; change24h: string; high24h: string; low24h: string }
> = {
  'BTC-USD': {
    basePrice: 65_000,
    change24h: '1.42',
    high24h: '66750.00',
    low24h: '64110.00',
  },
  'ETH-USD': {
    basePrice: 3_500,
    change24h: '-0.68',
    high24h: '3592.00',
    low24h: '3440.00',
  },
};

function buildCandles(symbol: MarketSymbol, limit: number): MarketCandle[] {
  const market = mockMarkets[symbol];
  const bucket =
    Math.floor(Date.now() / 1000 / CANDLE_GRANULARITY) * CANDLE_GRANULARITY;
  return Array.from({ length: limit }, (_, index) => {
    const time = bucket - (limit - 1 - index) * CANDLE_GRANULARITY;
    const scale = symbol === 'BTC-USD' ? 1 : 0.055;
    const open =
      market.basePrice + index * 8 * scale + Math.sin(index / 5) * 180 * scale;
    const close = open + Math.sin(index / 3) * 55 * scale;
    return {
      time,
      open: open.toFixed(2),
      high: (Math.max(open, close) + 72 * scale).toFixed(2),
      low: (Math.min(open, close) - 64 * scale).toFixed(2),
      close: close.toFixed(2),
      volume: (4 + Math.abs(Math.sin(index)) * 9).toFixed(8),
    };
  });
}

@Injectable()
export class MockMarketDataProvider implements MarketDataProvider {
  readonly source = 'SIMULATED' as const;
  private readonly listeners = new Set<(event: MarketProviderEvent) => void>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private currentStatus: MarketDataStatus = 'OFFLINE';

  get status() {
    return this.currentStatus;
  }

  subscribe(listener: (event: MarketProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start() {
    if (this.interval) {
      return;
    }
    this.emit({ type: 'status', status: 'LIVE' });
    this.interval = setInterval(() => this.emitTick(), 1_000);
    this.interval.unref();
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.emit({ type: 'status', status: 'OFFLINE' });
  }

  async fetchCandles(symbol: MarketSymbol, limit: number) {
    return buildCandles(symbol, limit);
  }

  async fetchTicker(symbol: MarketSymbol): Promise<ProviderTicker> {
    const market = mockMarkets[symbol];
    const price =
      buildCandles(symbol, 1)[0]?.close ?? market.basePrice.toFixed(2);
    return {
      symbol,
      price,
      bid: (Number(price) - 0.5).toFixed(2),
      ask: (Number(price) + 0.5).toFixed(2),
      change24h: market.change24h,
      high24h: market.high24h,
      low24h: market.low24h,
      volume24h: symbol === 'BTC-USD' ? '12450.25000000' : '98420.75000000',
      updatedAt: new Date().toISOString(),
    };
  }

  private emitTick() {
    this.tick += 1;
    const time =
      Math.floor(Date.now() / 1000 / CANDLE_GRANULARITY) * CANDLE_GRANULARITY;
    for (const symbol of MARKET_SYMBOLS) {
      const market = mockMarkets[symbol];
      const movement = symbol === 'BTC-USD' ? 120 : 8;
      const spread = symbol === 'BTC-USD' ? 0.5 : 0.05;
      const price = market.basePrice + Math.sin(this.tick / 4) * movement;
      const ticker: ProviderTicker = {
        symbol,
        price: price.toFixed(2),
        bid: (price - spread).toFixed(2),
        ask: (price + spread).toFixed(2),
        change24h: market.change24h,
        high24h: market.high24h,
        low24h: market.low24h,
        volume24h: symbol === 'BTC-USD' ? '12450.25000000' : '98420.75000000',
        updatedAt: new Date().toISOString(),
      };
      this.emit({ type: 'ticker', ticker });
      this.emit({
        type: 'candle',
        symbol,
        candle: {
          time,
          open: market.basePrice.toFixed(2),
          high: Math.max(market.basePrice, price).toFixed(2),
          low: Math.min(market.basePrice, price).toFixed(2),
          close: price.toFixed(2),
          volume: (10 + this.tick / 10).toFixed(8),
        },
      });
    }
  }

  private emit(event: MarketProviderEvent) {
    if (event.type === 'status') {
      if (this.currentStatus === event.status) {
        return;
      }
      this.currentStatus = event.status;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
