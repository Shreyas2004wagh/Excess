import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { RateLimitGuard } from './rate-limit.guard.js';
import { RequestLoggingInterceptor } from './request-logging.interceptor.js';

@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
})
export class OperationalModule {}
