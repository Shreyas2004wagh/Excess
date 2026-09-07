import { describe, expect, it, jest } from '@jest/globals';
import type {
  MarketCandle,
  MarketDataStatus,
  MarketStreamEvent,
} from '@excess/shared-types';

import { DatabaseService } from '../database/database.service.js';
import type { RedisService } from '../redis/redis.service.js';
import { MarketDataService } from './market-data.service.js';
import type {
  MarketDataProvider,
  MarketProviderEvent,
  ProviderTicker,
} from './market-data.types.js';

class MemoryRedis {
  private readonly values = new Map<string, unknown>();

  async getJson<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async setJson(key: string, value: unknown) {
    this.values.set(key, value);
  }
}

class FakeProvider implements MarketDataProvider {
  readonly source = 'SIMULATED' as const;
  status: MarketDataStatus = 'LIVE';
  private readonly listeners = new Set<(event: MarketProviderEvent) => void>();

  start = jest.fn(async () => undefined);
  stop = jest.fn(async () => undefined);

  async fetchCandles(limit: number): Promise<MarketCandle[]> {
    return Array.from({ length: limit }, (_, index) => ({
      time: 1_788_000_000 + index * 300,
      open: `${65_000 + index}`,
      high: `${65_010 + index}`,
      low: `${64_990 + index}`,
      close: `${65_005 + index}`,
      volume: '10.25',
    }));
  }

  async fetchTicker(): Promise<ProviderTicker> {
    return {
      symbol: 'BTC-USD',
      price: '65005',
      bid: '65004.99',
      ask: '65005.01',
      change24h: '1.5',
      high24h: '66000',
      low24h: '64000',
      volume24h: '1200',
      updatedAt: new Date().toISOString(),
    };
  }

  subscribe(listener: (event: MarketProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: MarketProviderEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

describe('MarketDataService', () => {
  const database = new DatabaseService();
  const provider = new FakeProvider();
  const service = new MarketDataService(
    database,
    new MemoryRedis() as unknown as RedisService,
    provider,
  );

  beforeAll(async () => {
    await database.onModuleInit();
    await service.onApplicationBootstrap();
  });

  afterAll(async () => {
    await service.onModuleDestroy();
    await database.onModuleDestroy();
  });

  it('provisions BTC-USD and returns normalized history and instrument data', async () => {
    const instrument = await service.getInstrument('BTC-USD');
    const history = await service.getCandles('BTC-USD', 100);

    expect(instrument).toMatchObject({
      symbol: 'BTC-USD',
      displayName: 'BTC/USD',
      tickSize: '0.01',
      ticker: { price: '65005', source: 'SIMULATED' },
    });
    expect(history.items).toHaveLength(100);
    expect(history.granularity).toBe(300);
    expect(history.items[0]?.time).toBeLessThan(
      history.items.at(-1)?.time ?? 0,
    );
    expect(service.isReady()).toBe(true);
  });

  it('broadcasts live ticker and current-candle updates', async () => {
    const messages: MarketStreamEvent[] = [];
    const unsubscribe = service.subscribe((event) => messages.push(event));
    const candle: MarketCandle = {
      time: 1_788_200_000,
      open: '65100',
      high: '65200',
      low: '65050',
      close: '65180',
      volume: '12',
    };

    provider.emit({
      type: 'ticker',
      ticker: {
        ...(await provider.fetchTicker()),
        price: '65180',
      },
    });
    provider.emit({ type: 'candle', symbol: 'BTC-USD', candle });
    await new Promise((resolve) => setTimeout(resolve, 5));
    unsubscribe();

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'market:ticker' }),
        { event: 'market:candle', data: { symbol: 'BTC-USD', candle } },
      ]),
    );
  });

  it('rejects unsupported instruments', async () => {
    await expect(service.getInstrument('ETH-USD')).rejects.toMatchObject({
      status: 404,
    });
  });
});
