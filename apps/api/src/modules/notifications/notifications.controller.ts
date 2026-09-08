import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type {
  NotificationSummary,
  NotificationsResponse,
} from '@excess/shared-types';
import { z } from 'zod';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import { NotificationsService } from './notifications.service.js';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<NotificationsResponse> {
    return this.notifications.listNotifications(identity);
  }

  @Patch(':notificationId/read')
  markRead(
    @CurrentIdentity() identity: ClerkIdentity,
    @Param('notificationId') notificationId: string,
  ): Promise<NotificationSummary> {
    const parsed = z.uuid().safeParse(notificationId);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_NOTIFICATION_ID',
        message: 'The notification identifier is invalid',
      });
    }
    return this.notifications.markRead(identity, parsed.data);
  }

  @Post('read-all')
  markAllRead(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<NotificationsResponse> {
    return this.notifications.markAllRead(identity);
  }
}
