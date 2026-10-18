import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { WebhookEvent } from '@clerk/backend';
import type { DatabaseService } from '../database/database.service.js';
import type { ClerkWebhookVerifier } from './webhook-verifier.types.js';
import { WebhooksService } from './webhooks.service.js';

describe('Clerk profile webhook authorization', () => {
  it.each(['verified', 'unverified', undefined])(
    'only trusts a verified primary email (%s)',
    async (status) => {
      const updateMany = jest
        .fn<(args: unknown) => Promise<{ count: number }>>()
        .mockResolvedValue({ count: 1 });
      const database = {
        client: { user: { updateMany } },
      } as unknown as DatabaseService;
      const config = {
        get: (key: string) =>
          key === 'ADMIN_EMAILS' ? 'admin@example.com' : 'whsec_fixture',
      } as unknown as ConfigService;
      const event = {
        type: 'user.updated',
        data: {
          id: 'user_fixture',
          primary_email_address_id: 'primary',
          email_addresses: [
            {
              id: 'primary',
              email_address: 'admin@example.com',
              verification: { status },
            },
          ],
          first_name: 'Trader',
        },
      } as unknown as WebhookEvent;
      const verifier = {
        verify: jest.fn(async () => event),
      } as ClerkWebhookVerifier;
      await new WebhooksService(config, database, verifier).handleClerkWebhook(
        new Request('https://api.example.com/api/v1/webhooks/clerk'),
      );
      expect(updateMany).toHaveBeenCalledWith({
        where: { clerkId: 'user_fixture' },
        data: {
          ...(status === 'verified' ? { email: 'admin@example.com' } : {}),
          role: status === 'verified' ? 'ADMIN' : 'TRADER',
          displayName: 'Trader',
        },
      });
    },
  );
});
