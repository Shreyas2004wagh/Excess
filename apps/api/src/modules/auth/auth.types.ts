import type { Request } from 'express';

export interface ClerkIdentity {
  clerkUserId: string;
  sessionId: string;
}

export interface AuthenticatedRequest extends Request {
  identity: ClerkIdentity;
  requestId: string;
}

export interface ClerkUserProfile {
  clerkUserId: string;
  email: string | null;
  displayName: string | null;
}

export interface ClerkAuthenticationState {
  isAuthenticated: boolean;
  toAuth(): {
    userId?: string | null;
    sessionId?: string | null;
  } | null;
}

export interface ClerkGateway {
  authenticate(request: globalThis.Request): Promise<ClerkAuthenticationState>;
  getUserProfile(clerkUserId: string): Promise<ClerkUserProfile>;
}
