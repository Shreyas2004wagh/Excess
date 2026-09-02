import { Module } from '@nestjs/common';

import { MarketDataModule } from '../market-data/market-data.module.js';
import { TradingController } from './trading.controller.js';
import { TradingService } from './trading.service.js';

@Module({
  imports: [MarketDataModule],
  controllers: [TradingController],
  providers: [TradingService],
  exports: [TradingService],
})
export class TradingModule {}
