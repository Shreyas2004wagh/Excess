import { Injectable } from '@nestjs/common';
import type { MarketCandle, MarketDataStatus } from '@excess/shared-types';

import {
  CANDLE_GRANULARITY,
  MARKET_SYMBOL,
  type MarketDataProvider,
  type MarketProviderEvent,
  type ProviderTicker,
} from './market-data.types.js';

function buildCandles(limit: number): MarketCandle[] {
  const bucket =
    Math.floor(Date.now() / 1000 / CANDLE_GRANULARITY) * CANDLE_GRANULARITY;
  return Array.from({ length: limit }, (_, index) => {
    const time = bucket - (limit - 1 - index) * CANDLE_GRANULARITY;
    const open = 65_000 + index * 8 + Math.sin(index / 5) * 180;
    const close = open + Math.sin(index / 3) * 55;
    return {
      time,
      open: open.toFixed(2),
      high: (Math.max(open, close) + 72).toFixed(2),
      low: (Math.min(open, close) - 64).toFixed(2),
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

  async fetchCandles(limit: number) {
    return buildCandles(limit);
  }

  async fetchTicker(): Promise<ProviderTicker> {
    const price = buildCandles(1)[0]?.close ?? '65000.00';
    return {
      symbol: MARKET_SYMBOL,
      price,
      bid: (Number(price) - 0.5).toFixed(2),
      ask: (Number(price) + 0.5).toFixed(2),
      change24h: '1.42',
      high24h: '66750.00',
      low24h: '64110.00',
      volume24h: '12450.25000000',
      updatedAt: new Date().toISOString(),
    };
  }

  private emitTick() {
    this.tick += 1;
    const price = 65_000 + Math.sin(this.tick / 4) * 120;
    const time =
      Math.floor(Date.now() / 1000 / CANDLE_GRANULARITY) * CANDLE_GRANULARITY;
    const ticker: ProviderTicker = {
      symbol: MARKET_SYMBOL,
      price: price.toFixed(2),
      bid: (price - 0.5).toFixed(2),
      ask: (price + 0.5).toFixed(2),
      change24h: '1.42',
      high24h: '66750.00',
      low24h: '64110.00',
      volume24h: '12450.25000000',
      updatedAt: new Date().toISOString(),
    };
    this.emit({ type: 'ticker', ticker });
    this.emit({
      type: 'candle',
      symbol: MARKET_SYMBOL,
      candle: {
        time,
        open: '65000.00',
        high: Math.max(65_000, price).toFixed(2),
        low: Math.min(65_000, price).toFixed(2),
        close: price.toFixed(2),
        volume: (10 + this.tick / 10).toFixed(8),
      },
    });
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
