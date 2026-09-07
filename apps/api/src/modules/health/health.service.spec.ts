import { jest } from '@jest/globals';

import type { DatabaseService } from '../database/database.service.js';
import type { MarketDataService } from '../market-data/market-data.service.js';
import type { RedisService } from '../redis/redis.service.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  const database = { ping: jest.fn(async () => true) };
  const redis = { ping: jest.fn(async () => true) };
  const marketData = { isReady: jest.fn(() => true) };
  const service = new HealthService(
    database as unknown as DatabaseService,
    redis as unknown as RedisService,
    marketData as unknown as MarketDataService,
  );

  it('reports that the API is healthy', () => {
    const health = service.getHealth();

    expect(health.service).toBe('excess-api');
    expect(health.status).toBe('ok');
    expect(health.timestamp).toBeDefined();
  });

  it('reports readiness when every dependency is available', async () => {
    await expect(service.getReadiness()).resolves.toMatchObject({
      status: 'ready',
      checks: { database: 'up', redis: 'up', marketData: 'up' },
    });
  });

  it('reports which dependency prevents readiness', async () => {
    redis.ping.mockResolvedValueOnce(false);

    await expect(service.getReadiness()).resolves.toMatchObject({
      status: 'not_ready',
      checks: { database: 'up', redis: 'down', marketData: 'up' },
    });
  });
});
