import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserStatus, type Prisma } from '@excess/database';
import type {
  NotificationSummary,
  NotificationsResponse,
} from '@excess/shared-types';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';

type StoredNotification = Prisma.NotificationGetPayload<Record<string, never>>;

function metadataRecord(
  metadata: Prisma.JsonValue,
): Record<string, unknown> | null {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function serializeNotification(
  notification: StoredNotification,
): NotificationSummary {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    metadata: metadataRecord(notification.metadata),
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

@Injectable()
export class NotificationsService {
  constructor(private readonly database: DatabaseService) {}

  async listNotifications(
    identity: ClerkIdentity,
  ): Promise<NotificationsResponse> {
    const user = await this.requireActiveUser(identity);
    const [notifications, unreadCount] = await Promise.all([
      this.database.client.notification.findMany({
        where: { userId: user.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
      this.database.client.notification.count({
        where: { userId: user.id, readAt: null },
      }),
    ]);
    return {
      items: notifications.map(serializeNotification),
      unreadCount,
    };
  }

  async markRead(identity: ClerkIdentity, notificationId: string) {
    const user = await this.requireActiveUser(identity);
    const notification = await this.database.client.notification.findFirst({
      where: { id: notificationId, userId: user.id },
    });
    if (!notification) {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'The notification could not be found',
      });
    }
    if (notification.readAt) {
      return serializeNotification(notification);
    }
    return serializeNotification(
      await this.database.client.notification.update({
        where: { id: notification.id },
        data: { readAt: new Date() },
      }),
    );
  }

  async markAllRead(identity: ClerkIdentity) {
    const user = await this.requireActiveUser(identity);
    await this.database.client.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return this.listNotifications(identity);
  }

  private async requireActiveUser(identity: ClerkIdentity) {
    const user = await this.database.client.user.findUnique({
      where: { clerkId: identity.clerkUserId },
    });
    if (!user) {
      throw new NotFoundException({
        code: 'SESSION_NOT_BOOTSTRAPPED',
        message: 'Bootstrap the session before loading notifications',
      });
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This Excess account is suspended',
      });
    }
    return user;
  }
}
