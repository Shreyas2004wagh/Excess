import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { MarketStreamEvent } from '@excess/shared-types';

import type { DatabaseService } from '../database/database.service.js';
import type { RedisService } from '../redis/redis.service.js';
import { MarketDataService } from './market-data.service.js';
import { MarketDataController } from './market-data.controller.js';
import type {
  MarketDataProvider,
  MarketProviderEvent,
} from './market-data.types.js';

describe('Market depth delivery', () => {
  let service: MarketDataService;
  let emit: (event: MarketProviderEvent) => void;
  let messages: MarketStreamEvent[];

  beforeEach(async () => {
    emit = () => undefined;
    messages = [];
    const database = {
      client: { instrument: { upsert: jest.fn(async () => undefined) } },
    } as unknown as DatabaseService;
    const redis = {
      getJson: jest.fn(async () => null),
      setJson: jest.fn(async () => undefined),
    } as unknown as RedisService;
    const provider: MarketDataProvider = {
      source: 'SIMULATED',
      status: 'LIVE',
      start: async () => {
        emit({ type: 'status', status: 'LIVE' });
      },
      stop: async () => undefined,
      fetchCandles: async () => [],
      fetchTicker: async (symbol) => ({
        symbol,
        price: '100',
        bid: '99',
        ask: '101',
        change24h: '0',
        high24h: '100',
        low24h: '100',
        volume24h: '10',
        updatedAt: new Date().toISOString(),
      }),
      subscribe: (listener) => {
        emit = listener;
        return () => undefined;
      },
    };
    service = new MarketDataService(database, redis, provider);
    await service.onApplicationBootstrap();
    service.subscribe((message) => messages.push(message));
  });

  const snapshot = () => ({
    type: 'orderbook' as const,
    book: {
      symbol: 'BTC-USD' as const,
      bids: [{ price: '99.00', quantity: '1.25000000' }],
      asks: [{ price: '101.00', quantity: '2.50000000' }],
      updatedAt: '2026-10-14T12:00:00.000Z',
    },
  });

  it('returns a connecting state until a synchronized snapshot arrives', () => {
    expect(service.getOrderBook('btc-usd')).toMatchObject({
      status: 'CONNECTING',
      bids: [],
      asks: [],
      updatedAt: null,
    });
    emit(snapshot());
    const controller = new MarketDataController(service);
    const book = controller.getOrderBook('BTC-USD');
    expect(book).toMatchObject({
      source: 'SIMULATED',
      status: 'LIVE',
      bids: [{ price: '99.00', quantity: '1.25000000' }],
    });
    expect(messages).toContainEqual({ event: 'market:orderbook', data: book });
    expect(service.getCurrentOrderBooks()).toHaveLength(2);
  });

  it('marks retained depth stale and clears it on a disconnect', () => {
    emit(snapshot());
    emit({ type: 'status', status: 'STALE' });
    expect(service.getOrderBook('BTC-USD')).toMatchObject({
      status: 'STALE',
      bids: [{ price: '99.00', quantity: '1.25000000' }],
    });
    emit({ type: 'status', status: 'OFFLINE' });
    expect(service.getOrderBook('BTC-USD')).toMatchObject({
      status: 'OFFLINE',
      bids: [],
      asks: [],
      updatedAt: null,
    });
    expect(messages).toContainEqual({
      event: 'market:orderbook',
      data: service.getOrderBook('BTC-USD'),
    });
    emit({ type: 'status', status: 'LIVE' });
    expect(service.getOrderBook('BTC-USD').status).toBe('CONNECTING');
    emit(snapshot());
    expect(service.getOrderBook('BTC-USD').status).toBe('LIVE');
  });

  it('rejects unsupported symbols and isolates the supported books', () => {
    emit(snapshot());
    expect(service.getOrderBook('ETH-USD').bids).toEqual([]);
    expect(() => service.getOrderBook('SOL-USD')).toThrow(
      'Instrument SOL-USD is not available',
    );
  });
});
