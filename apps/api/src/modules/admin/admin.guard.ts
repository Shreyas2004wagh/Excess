import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserRole, UserStatus } from '@excess/database';

import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = await this.database.client.user.findUnique({
      where: { clerkId: request.identity.clerkUserId },
      select: { role: true, status: true, identityDeletedAt: true },
    });
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      user.identityDeletedAt ||
      user.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException({
        code: 'ADMIN_REQUIRED',
        message: 'Administrator access is required',
      });
    }
    return true;
  }
}
