import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  MARKET_SYMBOLS,
  type OpenOrdersResponse,
  type OrderPlacementRequest,
  type OrderPlacementResponse,
  type OrderSummary,
  type PortfolioSummary,
  type TradeHistoryPage,
  type TradingPerformanceSummary,
} from '@excess/shared-types';
import { z } from 'zod';

import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import type { ClerkIdentity } from '../auth/auth.types.js';
import { TradingService } from './trading.service.js';

const decimalString = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((value) => Number(value) > 0);
const orderBase = z.object({
  clientOrderId: z.uuid(),
  symbol: z.enum(MARKET_SYMBOLS),
  side: z.enum(['BUY', 'SELL']),
  quantity: decimalString,
  leverage: z
    .union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)])
    .optional(),
  stopLossPrice: decimalString.optional(),
  takeProfitPrice: decimalString.optional(),
});
const orderSchema = z.discriminatedUnion('type', [
  orderBase.extend({ type: z.literal('MARKET') }),
  orderBase.extend({ type: z.literal('LIMIT'), limitPrice: decimalString }),
  orderBase.extend({ type: z.literal('STOP'), stopPrice: decimalString }),
]);
const tradeHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
  symbol: z.enum(MARKET_SYMBOLS).optional(),
});

@Controller('trading')
export class TradingController {
  constructor(private readonly trading: TradingService) {}

  @Post('orders')
  placeOrder(
    @CurrentIdentity() identity: ClerkIdentity,
    @Body() body: unknown,
  ): Promise<OrderPlacementResponse> {
    const result = orderSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        code: 'INVALID_ORDER',
        message:
          'Provide a valid supported instrument, quantity, and required price',
      });
    }
    return this.trading.placeOrder(
      identity,
      result.data as OrderPlacementRequest,
    );
  }

  @Get('portfolio')
  getPortfolio(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<PortfolioSummary> {
    return this.trading.getPortfolio(identity);
  }

  @Get('orders/open')
  getOpenOrders(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<OpenOrdersResponse> {
    return this.trading.getOpenOrders(identity);
  }

  @Get('trades')
  getTradeHistory(
    @CurrentIdentity() identity: ClerkIdentity,
    @Query() query: Record<string, string | undefined>,
  ): Promise<TradeHistoryPage> {
    const result = tradeHistoryQuerySchema.safeParse(query);
    if (!result.success) {
      throw new BadRequestException({
        code: 'INVALID_TRADE_HISTORY_QUERY',
        message: 'Use a valid symbol, cursor, and limit between 1 and 100',
      });
    }
    return this.trading.getTradeHistory(identity, result.data);
  }

  @Get('performance')
  getPerformance(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<TradingPerformanceSummary> {
    return this.trading.getPerformance(identity);
  }

  @Delete('orders/:orderId')
  cancelOrder(
    @CurrentIdentity() identity: ClerkIdentity,
    @Param('orderId') orderId: string,
  ): Promise<OrderSummary> {
    const parsed = z.uuid().safeParse(orderId);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_ORDER_ID',
        message: 'The order identifier is invalid',
      });
    }
    return this.trading.cancelOrder(identity, parsed.data);
  }
}
