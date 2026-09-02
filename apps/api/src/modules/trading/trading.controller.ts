import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';
import type {
  MarketOrderRequest,
  MarketOrderResponse,
  PortfolioSummary,
} from '@excess/shared-types';
import { z } from 'zod';

import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import type { ClerkIdentity } from '../auth/auth.types.js';
import { TradingService } from './trading.service.js';

const marketOrderSchema = z.object({
  clientOrderId: z.uuid(),
  symbol: z.literal('BTC-USD'),
  side: z.enum(['BUY', 'SELL']),
  type: z.literal('MARKET'),
  quantity: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .refine((value) => Number(value) > 0),
});

@Controller('trading')
export class TradingController {
  constructor(private readonly trading: TradingService) {}

  @Post('orders')
  placeMarketOrder(
    @CurrentIdentity() identity: ClerkIdentity,
    @Body() body: unknown,
  ): Promise<MarketOrderResponse> {
    const result = marketOrderSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        code: 'INVALID_MARKET_ORDER',
        message: 'Provide a valid BTC-USD market order and positive quantity',
      });
    }
    return this.trading.placeMarketOrder(
      identity,
      result.data as MarketOrderRequest,
    );
  }

  @Get('portfolio')
  getPortfolio(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<PortfolioSummary> {
    return this.trading.getPortfolio(identity);
  }
}
