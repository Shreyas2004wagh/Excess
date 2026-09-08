import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  AdminDeliverySummary,
  AdminOverviewResponse,
} from '@excess/shared-types';
import { z } from 'zod';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import { AdminGuard } from './admin.guard.js';
import { AdminService } from './admin.service.js';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<AdminOverviewResponse> {
    return this.admin.getOverview(identity);
  }

  @Post('deliveries/:eventId/retry')
  retryDelivery(
    @CurrentIdentity() identity: ClerkIdentity,
    @Param('eventId') eventId: string,
  ): Promise<AdminDeliverySummary> {
    const parsed = z.uuid().safeParse(eventId);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_OUTBOX_EVENT_ID',
        message: 'The delivery event identifier is invalid',
      });
    }
    return this.admin.retryDelivery(identity, parsed.data);
  }
}
