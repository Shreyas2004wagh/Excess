import { Injectable } from '@nestjs/common';
import type { HealthResponse, ReadinessResponse } from '@excess/shared-types';

import { DatabaseService } from '../database/database.service.js';
import { MarketDataService } from '../market-data/market-data.service.js';
import { RedisService } from '../redis/redis.service.js';

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly marketData: MarketDataService,
  ) {}

  getHealth(): HealthResponse {
    return {
      service: 'excess-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<ReadinessResponse> {
    const [database, redis] = await Promise.all([
      this.database.ping(),
      this.redis.ping(),
    ]);
    const marketData = this.marketData.isReady();

    return {
      service: 'excess-api',
      status: database && redis && marketData ? 'ready' : 'not_ready',
      checks: {
        database: database ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
        marketData: marketData ? 'up' : 'down',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
