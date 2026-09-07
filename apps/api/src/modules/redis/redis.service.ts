import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

export interface RateLimitConsumption {
  count: number;
  ttlSeconds: number;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client;
  private reconnectPromise: Promise<boolean> | null = null;
  private reconnectAfter = 0;

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
    await this.ensureConnected();
  }

  async onModuleDestroy() {
    if (this.client.isOpen) {
      await this.client.close();
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!(await this.ensureConnected())) {
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
    if (!(await this.ensureConnected())) {
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

  async ping() {
    if (!(await this.ensureConnected())) return false;
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async consumeRateLimit(
    key: string,
    windowSeconds: number,
  ): Promise<RateLimitConsumption | null> {
    if (!(await this.ensureConnected())) return null;
    try {
      const result = await this.client.eval(RATE_LIMIT_SCRIPT, {
        keys: [key],
        arguments: [String(windowSeconds)],
      });
      if (!Array.isArray(result)) return null;
      const count = Number(result[0]);
      const ttlSeconds = Number(result[1]);
      if (!Number.isFinite(count) || !Number.isFinite(ttlSeconds)) return null;
      return { count, ttlSeconds: Math.max(1, ttlSeconds) };
    } catch (error) {
      this.logger.warn(
        `Redis rate-limit operation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
  }

  private async ensureConnected() {
    if (this.client.isReady) {
      return true;
    }
    if (this.client.isOpen) {
      return false;
    }
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }
    if (Date.now() < this.reconnectAfter) {
      return false;
    }

    this.reconnectAfter = Date.now() + 5_000;
    this.reconnectPromise = this.client
      .connect()
      .then(() => true)
      .catch((error: unknown) => {
        this.logger.warn(
          `Redis unavailable; continuing in memory: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        return false;
      })
      .finally(() => {
        this.reconnectPromise = null;
      });
    return this.reconnectPromise;
  }
}
