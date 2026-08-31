import { Controller, HttpCode, Post } from '@nestjs/common';
import type { SessionBootstrapResponse } from '@excess/shared-types';

import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import type { ClerkIdentity } from '../auth/auth.types.js';
import { SessionService } from './session.service.js';

@Controller('session')
export class SessionController {
  constructor(private readonly session: SessionService) {}

  @Post('bootstrap')
  @HttpCode(200)
  bootstrap(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<SessionBootstrapResponse> {
    return this.session.bootstrap(identity);
  }
}
