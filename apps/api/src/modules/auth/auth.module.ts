import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { ClerkAuthGuard } from './clerk-auth.guard.js';
import { ClerkService } from './clerk.service.js';
import { CLERK_GATEWAY } from './auth.tokens.js';

@Module({
  providers: [
    ClerkService,
    {
      provide: CLERK_GATEWAY,
      useExisting: ClerkService,
    },
    {
      provide: APP_GUARD,
      useClass: ClerkAuthGuard,
    },
  ],
  exports: [CLERK_GATEWAY],
})
export class AuthModule {}
