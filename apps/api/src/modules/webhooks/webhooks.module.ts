import { Module } from '@nestjs/common';

import { ClerkWebhookVerifierService } from './clerk-webhook-verifier.service.js';
import { CLERK_WEBHOOK_VERIFIER } from './webhook-verifier.types.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

@Module({
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    ClerkWebhookVerifierService,
    {
      provide: CLERK_WEBHOOK_VERIFIER,
      useExisting: ClerkWebhookVerifierService,
    },
  ],
})
export class WebhooksModule {}
