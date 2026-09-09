import { Module } from '@nestjs/common';

import { AlertEmailService } from './alert-email.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [AlertEmailService, NotificationsService, OutboxDispatcherService],
  exports: [NotificationsService, OutboxDispatcherService],
})
export class NotificationsModule {}
