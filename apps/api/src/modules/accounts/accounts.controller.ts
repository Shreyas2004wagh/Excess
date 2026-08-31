import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { DemoAccountSummary, LedgerPage } from '@excess/shared-types';
import { z } from 'zod';

import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import type { ClerkIdentity } from '../auth/auth.types.js';
import { AccountsService } from './accounts.service.js';

const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});

@Controller('accounts/demo')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  getDemoAccount(
    @CurrentIdentity() identity: ClerkIdentity,
  ): Promise<DemoAccountSummary> {
    return this.accounts.getDemoAccount(identity);
  }

  @Get('ledger')
  getLedger(
    @CurrentIdentity() identity: ClerkIdentity,
    @Query() query: Record<string, string | undefined>,
  ): Promise<LedgerPage> {
    const result = ledgerQuerySchema.safeParse(query);
    if (!result.success) {
      throw new BadRequestException({
        code: 'INVALID_LEDGER_QUERY',
        message: 'Ledger pagination parameters are invalid',
      });
    }
    return this.accounts.getLedger(identity, result.data);
  }
}
