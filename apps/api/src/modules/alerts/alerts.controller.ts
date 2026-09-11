import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  MARKET_SYMBOLS,
  type CreatePriceAlertRequest,
  type PriceAlertsResponse,
  type PriceAlertSummary,
} from '@excess/shared-types';
import { z } from 'zod';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import { AlertsService } from './alerts.service.js';

const createAlertSchema = z.object({
  symbol: z.enum(MARKET_SYMBOLS),
  direction: z.enum(['ABOVE', 'BELOW']),
  targetPrice: z.string().regex(/^\d+(?:\.\d+)?$/),
});

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Post()
  createAlert(
    @CurrentIdentity() identity: ClerkIdentity,
    @Body() body: unknown,
  ): Promise<PriceAlertSummary> {
    const result = createAlertSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        code: 'INVALID_PRICE_ALERT',
        message: 'Provide a valid instrument, direction, and target price',
      });
    }
    return this.alerts.createAlert(
      identity,
      result.data as CreatePriceAlertRequest,
    );
  }

  @Get()
  listAlerts(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<PriceAlertsResponse> {
    return this.alerts.listAlerts(identity);
  }

  @Delete(':alertId')
  cancelAlert(
    @CurrentIdentity() identity: ClerkIdentity,
    @Param('alertId') alertId: string,
  ): Promise<PriceAlertSummary> {
    const parsed = z.uuid().safeParse(alertId);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_PRICE_ALERT_ID',
        message: 'The price alert identifier is invalid',
      });
    }
    return this.alerts.cancelAlert(identity, parsed.data);
  }
}
