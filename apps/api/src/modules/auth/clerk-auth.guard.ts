import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { CLERK_GATEWAY } from './auth.tokens.js';
import type { AuthenticatedRequest, ClerkGateway } from './auth.types.js';
import { IS_PUBLIC_ROUTE } from './public.decorator.js';

function toWebRequest(request: Request) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const host = request.get('host') ?? 'localhost';
  return new globalThis.Request(
    `${request.protocol}://${host}${request.originalUrl}`,
    { method: request.method, headers },
  );
}

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CLERK_GATEWAY) private readonly clerk: ClerkGateway,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_ROUTE,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    try {
      const state = await this.clerk.authenticate(toWebRequest(request));
      if (!state.isAuthenticated) {
        throw new UnauthorizedException('Authentication required');
      }

      const auth = state.toAuth();
      if (!auth?.userId || !auth.sessionId) {
        throw new UnauthorizedException('A user session is required');
      }

      request.identity = {
        clerkUserId: auth.userId,
        sessionId: auth.sessionId,
      };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException(
        'Invalid or expired authentication token',
      );
    }
  }
}
