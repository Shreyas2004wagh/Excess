import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client;

  constructor(config: ConfigService) {
    this.client = createClient({
      url: config.getOrThrow<string>('REDIS_URL'),
      socket: {
        connectTimeout: 1_500,
        reconnectStrategy: false,
      },
    });
    this.client.on('error', (error) => {
      this.logger.warn(`Redis connection error: ${error.message}`);
    });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
    } catch (error) {
      this.logger.warn(
        `Redis cache unavailable; continuing in memory: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.client.isOpen) {
      await this.client.close();
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.client.isReady) {
      return null;
    }

    try {
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch (error) {
      this.logger.warn(
        `Redis read failed for ${key}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number) {
    if (!this.client.isReady) {
      return;
    }

    try {
      await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (error) {
      this.logger.warn(
        `Redis write failed for ${key}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
