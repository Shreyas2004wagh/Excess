import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient } from '@clerk/backend';

import type {
  ClerkAuthenticationState,
  ClerkUserProfile,
} from './auth.types.js';

@Injectable()
export class ClerkService {
  private readonly client;
  private readonly publishableKey: string;
  private readonly webOrigin: string;

  constructor(private readonly config: ConfigService) {
    const secretKey = this.config.getOrThrow<string>('CLERK_SECRET_KEY');
    this.publishableKey =
      this.config.get<string>('CLERK_PUBLISHABLE_KEY') ??
      this.config.getOrThrow<string>('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
    this.webOrigin = this.config.getOrThrow<string>('WEB_ORIGIN');
    this.client = createClerkClient({
      secretKey,
      publishableKey: this.publishableKey,
    });
  }

  async authenticate(request: Request): Promise<ClerkAuthenticationState> {
    return this.client.authenticateRequest(request, {
      acceptsToken: 'session_token',
      authorizedParties: [this.webOrigin],
      publishableKey: this.publishableKey,
    });
  }

  async getUserProfile(clerkUserId: string): Promise<ClerkUserProfile> {
    const user = await this.client.users.getUser(clerkUserId);
    const primaryEmail = user.primaryEmailAddress;
    const isVerified = primaryEmail?.verification?.status === 'verified';

    return {
      clerkUserId,
      email: isVerified ? primaryEmail.emailAddress : null,
      displayName: user.fullName,
    };
  }
}
