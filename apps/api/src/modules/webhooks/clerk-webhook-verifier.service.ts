import { Injectable } from '@nestjs/common';
import { verifyWebhook } from '@clerk/backend/webhooks';

@Injectable()
export class ClerkWebhookVerifierService {
  verify(request: Request, signingSecret: string) {
    return verifyWebhook(request, { signingSecret });
  }
}
