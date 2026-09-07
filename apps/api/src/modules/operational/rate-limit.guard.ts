import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { RedisService } from '../redis/redis.service.js';
import { SKIP_RATE_LIMIT } from './skip-rate-limit.decorator.js';

interface LocalWindow {
  count: number;
  expiresAt: number;
}

const MAXIMUM_LOCAL_WINDOWS = 10_000;

type RateLimitedRequest = Request & { identity?: ClerkIdentity };

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly localWindows = new Map<string, LocalWindow>();
  private readonly maximumRequests: number;
  private readonly windowSeconds: number;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.maximumRequests = config.getOrThrow<number>('RATE_LIMIT_MAX');
    this.windowSeconds = config.getOrThrow<number>('RATE_LIMIT_WINDOW_SECONDS');
  }

  async canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') {
      return true;
    }

    const skipped = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipped) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitedRequest>();
    const response = http.getResponse<Response>();
    const now = Date.now();
    const bucket = Math.floor(now / (this.windowSeconds * 1_000));
    const subject =
      request.identity?.clerkUserId ?? this.getClientAddress(request);
    const key = `rate-limit:${subject}:${bucket}`;
    const sharedConsumption = await this.redis.consumeRateLimit(
      key,
      this.windowSeconds,
    );
    const consumption =
      sharedConsumption ?? this.consumeLocally(key, now, this.windowSeconds);
    const resetAt = Math.ceil((now + consumption.ttlSeconds * 1_000) / 1_000);

    response.setHeader('X-RateLimit-Limit', this.maximumRequests);
    response.setHeader(
      'X-RateLimit-Remaining',
      Math.max(0, this.maximumRequests - consumption.count),
    );
    response.setHeader('X-RateLimit-Reset', resetAt);

    if (consumption.count > this.maximumRequests) {
      response.setHeader('Retry-After', consumption.ttlSeconds);
      throw new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests; retry after the current window',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private getClientAddress(request: Request) {
    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  private consumeLocally(key: string, now: number, windowSeconds: number) {
    const existing = this.localWindows.get(key);
    if (!existing || existing.expiresAt <= now) {
      const window = {
        count: 1,
        expiresAt: now + windowSeconds * 1_000,
      };
      this.localWindows.set(key, window);
      this.pruneLocalWindows(now);
      return { count: window.count, ttlSeconds: windowSeconds };
    }

    existing.count += 1;
    return {
      count: existing.count,
      ttlSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1_000)),
    };
  }

  private pruneLocalWindows(now: number) {
    if (this.localWindows.size < MAXIMUM_LOCAL_WINDOWS) {
      return;
    }
    for (const [key, window] of this.localWindows) {
      if (window.expiresAt <= now) {
        this.localWindows.delete(key);
      }
    }
    while (this.localWindows.size >= MAXIMUM_LOCAL_WINDOWS) {
      const oldestKey = this.localWindows.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.localWindows.delete(oldestKey);
    }
  }
}
