import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DatabaseService } from '../database/database.service.js';
import { CLERK_WEBHOOK_VERIFIER } from './webhook-verifier.types.js';
import type { ClerkWebhookVerifier } from './webhook-verifier.types.js';

function getPrimaryEmail(data: {
  primary_email_address_id?: string | null;
  email_addresses?: Array<{ id: string; email_address: string }>;
}) {
  return (
    data.email_addresses?.find(
      (email) => email.id === data.primary_email_address_id,
    )?.email_address ?? null
  );
}

function getDisplayName(data: {
  first_name?: string | null;
  last_name?: string | null;
}) {
  const displayName = [data.first_name, data.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return displayName || null;
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
    @Inject(CLERK_WEBHOOK_VERIFIER)
    private readonly verifier: ClerkWebhookVerifier,
  ) {}

  async handleClerkWebhook(request: Request) {
    const signingSecret = this.config.get<string>(
      'CLERK_WEBHOOK_SIGNING_SECRET',
    );
    if (!signingSecret) {
      throw new ServiceUnavailableException({
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: 'The Clerk webhook signing secret is not configured',
      });
    }

    let event;
    try {
      event = await this.verifier.verify(request, signingSecret);
    } catch {
      throw new BadRequestException({
        code: 'INVALID_WEBHOOK_SIGNATURE',
        message: 'The Clerk webhook signature is invalid',
      });
    }

    if (event.type === 'user.updated') {
      const email = getPrimaryEmail(event.data);
      await this.database.client.user.updateMany({
        where: { clerkId: event.data.id },
        data: {
          ...(email ? { email } : {}),
          displayName: getDisplayName(event.data),
        },
      });
    }

    if (event.type === 'user.deleted' && event.data.id) {
      await this.database.client.user.updateMany({
        where: { clerkId: event.data.id, identityDeletedAt: null },
        data: {
          status: 'SUSPENDED',
          identityDeletedAt: new Date(),
        },
      });
    }
  }
}
