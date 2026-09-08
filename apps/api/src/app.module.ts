import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from './config/environment.js';
import { AlertsModule } from './modules/alerts/alerts.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DatabaseModule } from './modules/database/database.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { MarketDataModule } from './modules/market-data/market-data.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OperationalModule } from './modules/operational/operational.module.js';
import { RedisModule } from './modules/redis/redis.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { SessionModule } from './modules/session/session.module.js';
import { TradingModule } from './modules/trading/trading.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['../web/.env.local', '../../.env'],
      isGlobal: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    RedisModule,
    AuthModule,
    HealthModule,
    SessionModule,
    AccountsModule,
    WebhooksModule,
    MarketDataModule,
    TradingModule,
    AlertsModule,
    NotificationsModule,
    OperationalModule,
  ],
})
export class AppModule {}
