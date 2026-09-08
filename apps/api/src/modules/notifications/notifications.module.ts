import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, OutboxDispatcherService],
  exports: [NotificationsService, OutboxDispatcherService],
})
export class NotificationsModule {}
