import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from './config/environment.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DatabaseModule } from './modules/database/database.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { SessionModule } from './modules/session/session.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['../web/.env.local', '../../.env'],
      isGlobal: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    AuthModule,
    HealthModule,
    SessionModule,
    AccountsModule,
    WebhooksModule,
  ],
})
export class AppModule {}
