import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  MarketCandle,
  MarketDataStatus,
  MarketSymbol,
} from '@excess/shared-types';
import WebSocket from 'ws';
import { z } from 'zod';

import {
  CANDLE_GRANULARITY,
  MARKET_SYMBOLS,
  isMarketSymbol,
  type MarketDataProvider,
  type MarketProviderEvent,
  type ProviderTicker,
} from './market-data.types.js';

const candleRowSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);

const tickerResponseSchema = z.object({
  price: z.string(),
  bid: z.string(),
  ask: z.string(),
  time: z.string(),
});

const statsResponseSchema = z.object({
  high: z.string(),
  low: z.string(),
  volume: z.string(),
  last: z.string(),
  open: z.string(),
});

const tickerMessageSchema = z.object({
  channel: z.literal('ticker'),
  timestamp: z.string(),
  events: z.array(
    z.object({
      tickers: z.array(
        z.object({
          product_id: z.string(),
          price: z.string(),
          best_bid: z.string(),
          best_ask: z.string(),
          price_percent_chg_24_h: z.string().optional(),
          high_24_h: z.string().optional(),
          low_24_h: z.string().optional(),
          volume_24_h: z.string().optional(),
        }),
      ),
    }),
  ),
});

const candleMessageSchema = z.object({
  channel: z.literal('candles'),
  events: z.array(
    z.object({
      candles: z.array(
        z.object({
          product_id: z.string(),
          start: z.string(),
          open: z.string(),
          high: z.string(),
          low: z.string(),
          close: z.string(),
          volume: z.string(),
        }),
      ),
    }),
  ),
});

function percentageChange(open: string, last: string) {
  const openValue = Number(open);
  const lastValue = Number(last);
  if (!Number.isFinite(openValue) || openValue === 0) {
    return '0';
  }
  return (((lastValue - openValue) / openValue) * 100).toString();
}

export function parseCoinbaseMessage(raw: string): MarketProviderEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }

  const tickerMessage = tickerMessageSchema.safeParse(value);
  if (tickerMessage.success) {
    return tickerMessage.data.events.flatMap((event) =>
      event.tickers.flatMap((ticker) => {
        if (!isMarketSymbol(ticker.product_id)) return [];
        return [
          {
            type: 'ticker' as const,
            ticker: {
              symbol: ticker.product_id,
              price: ticker.price,
              bid: ticker.best_bid,
              ask: ticker.best_ask,
              change24h: ticker.price_percent_chg_24_h ?? '0',
              high24h: ticker.high_24_h ?? ticker.price,
              low24h: ticker.low_24_h ?? ticker.price,
              volume24h: ticker.volume_24_h ?? '0',
              updatedAt: new Date(tickerMessage.data.timestamp).toISOString(),
            },
          },
        ];
      }),
    );
  }

  const candleMessage = candleMessageSchema.safeParse(value);
  if (candleMessage.success) {
    return candleMessage.data.events.flatMap((event) =>
      event.candles.flatMap((candle) => {
        if (!isMarketSymbol(candle.product_id)) return [];
        return [
          {
            type: 'candle' as const,
            symbol: candle.product_id,
            candle: {
              time: Number(candle.start),
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
            },
          },
        ];
      }),
    );
  }

  return [];
}

@Injectable()
export class CoinbaseMarketDataProvider implements MarketDataProvider {
  readonly source = 'COINBASE' as const;
  private readonly logger = new Logger(CoinbaseMarketDataProvider.name);
  private readonly listeners = new Set<(event: MarketProviderEvent) => void>();
  private readonly restUrl: string;
  private readonly websocketUrl: string;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private lastMessageAt = 0;
  private stopped = true;
  private currentStatus: MarketDataStatus = 'OFFLINE';

  constructor(config: ConfigService) {
    this.restUrl = config.getOrThrow<string>('COINBASE_REST_URL');
    this.websocketUrl = config.getOrThrow<string>('COINBASE_WS_URL');
  }

  get status() {
    return this.currentStatus;
  }

  subscribe(listener: (event: MarketProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
    this.staleTimer = setInterval(() => {
      if (
        this.currentStatus === 'LIVE' &&
        Date.now() - this.lastMessageAt > 15_000
      ) {
        this.emit({ type: 'status', status: 'STALE' });
      }
    }, 5_000);
    this.staleTimer.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.emit({ type: 'status', status: 'OFFLINE' });
  }

  async fetchCandles(
    symbol: MarketSymbol,
    limit: number,
  ): Promise<MarketCandle[]> {
    const url = new URL(`/products/${symbol}/candles`, this.restUrl);
    url.searchParams.set('granularity', CANDLE_GRANULARITY.toString());

    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Excess/0.2' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Coinbase candle request failed with ${response.status}`);
    }

    const rows = z.array(candleRowSchema).parse(await response.json());
    return rows
      .map(([time, low, high, open, close, volume]) => ({
        time,
        low: low.toString(),
        high: high.toString(),
        open: open.toString(),
        close: close.toString(),
        volume: volume.toString(),
      }))
      .sort((left, right) => left.time - right.time)
      .slice(-limit);
  }

  async fetchTicker(symbol: MarketSymbol): Promise<ProviderTicker> {
    const headers = { Accept: 'application/json', 'User-Agent': 'Excess/0.2' };
    const request = (path: string) =>
      fetch(new URL(path, this.restUrl), {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
    const [tickerResponse, statsResponse] = await Promise.all([
      request(`/products/${symbol}/ticker`),
      request(`/products/${symbol}/stats`),
    ]);
    if (!tickerResponse.ok || !statsResponse.ok) {
      throw new Error('Coinbase ticker request failed');
    }

    const ticker = tickerResponseSchema.parse(await tickerResponse.json());
    const stats = statsResponseSchema.parse(await statsResponse.json());
    return {
      symbol,
      price: ticker.price,
      bid: ticker.bid,
      ask: ticker.ask,
      change24h: percentageChange(stats.open, stats.last),
      high24h: stats.high,
      low24h: stats.low,
      volume24h: stats.volume,
      updatedAt: new Date(ticker.time).toISOString(),
    };
  }

  private connect() {
    if (this.stopped) {
      return;
    }
    this.emit({ type: 'status', status: 'CONNECTING' });
    const socket = new WebSocket(this.websocketUrl);
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          product_ids: MARKET_SYMBOLS,
          channel: 'ticker',
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          product_ids: MARKET_SYMBOLS,
          channel: 'candles',
        }),
      );
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats' }));
      this.emit({ type: 'status', status: 'LIVE' });
    });

    socket.on('message', (data) => {
      this.lastMessageAt = Date.now();
      for (const event of parseCoinbaseMessage(data.toString())) {
        this.emit(event);
      }
      if (this.currentStatus === 'STALE') {
        this.emit({ type: 'status', status: 'LIVE' });
      }
    });

    socket.on('error', (error) => {
      this.logger.warn(`Coinbase WebSocket error: ${error.message}`);
    });

    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.emit({ type: 'status', status: 'OFFLINE' });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        this.connect();
      },
      delay + Math.floor(Math.random() * 500),
    );
    this.reconnectTimer.unref();
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
