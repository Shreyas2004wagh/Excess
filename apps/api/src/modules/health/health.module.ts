import { Module } from '@nestjs/common';

import { MarketDataModule } from '../market-data/market-data.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [MarketDataModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
