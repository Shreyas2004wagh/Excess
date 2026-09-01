import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module.js';
import { CoinbaseMarketDataProvider } from './coinbase-market-data.provider.js';
import { MarketDataController } from './market-data.controller.js';
import { MarketDataGateway } from './market-data.gateway.js';
import { MarketDataService } from './market-data.service.js';
import { MARKET_DATA_PROVIDER } from './market-data.types.js';
import { MockMarketDataProvider } from './mock-market-data.provider.js';

@Module({
  imports: [AuthModule],
  controllers: [MarketDataController],
  providers: [
    CoinbaseMarketDataProvider,
    MockMarketDataProvider,
    {
      provide: MARKET_DATA_PROVIDER,
      inject: [
        ConfigService,
        CoinbaseMarketDataProvider,
        MockMarketDataProvider,
      ],
      useFactory: (
        config: ConfigService,
        coinbase: CoinbaseMarketDataProvider,
        mock: MockMarketDataProvider,
      ) =>
        config.get<string>('MARKET_DATA_PROVIDER') === 'mock' ? mock : coinbase,
    },
    MarketDataService,
    MarketDataGateway,
  ],
  exports: [MarketDataService],
})
export class MarketDataModule {}
