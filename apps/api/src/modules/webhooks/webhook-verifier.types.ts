import type { WebhookEvent } from '@clerk/backend';

export const CLERK_WEBHOOK_VERIFIER = Symbol('CLERK_WEBHOOK_VERIFIER');

export interface ClerkWebhookVerifier {
  verify(request: Request, signingSecret: string): Promise<WebhookEvent>;
}
