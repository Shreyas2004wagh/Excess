import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import type {
  CandleHistoryResponse,
  MarketInstrumentSummary,
  MarketInstrumentsResponse,
} from '@excess/shared-types';
import { z } from 'zod';

import { MarketDataService } from './market-data.service.js';

const candleQuerySchema = z.object({
  granularity: z.coerce.number().int().pipe(z.literal(300)).default(300),
  limit: z.coerce.number().int().min(50).max(300).default(300),
});

@Controller('market-data/instruments')
export class MarketDataController {
  constructor(private readonly marketData: MarketDataService) {}

  @Get()
  listInstruments(): Promise<MarketInstrumentsResponse> {
    return this.marketData.listInstruments();
  }

  @Get(':symbol')
  getInstrument(
    @Param('symbol') symbol: string,
  ): Promise<MarketInstrumentSummary> {
    return this.marketData.getInstrument(symbol);
  }

  @Get(':symbol/candles')
  getCandles(
    @Param('symbol') symbol: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<CandleHistoryResponse> {
    const result = candleQuerySchema.safeParse(query);
    if (!result.success) {
      throw new BadRequestException({
        code: 'INVALID_CANDLE_QUERY',
        message: 'Use five-minute candles and a limit between 50 and 300',
      });
    }
    return this.marketData.getCandles(symbol, result.data.limit);
  }
}
