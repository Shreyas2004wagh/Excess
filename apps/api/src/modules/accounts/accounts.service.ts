import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountType, UserStatus } from '@excess/database';
import type {
  DemoAccountSummary,
  LedgerEntrySummary,
  LedgerPage,
} from '@excess/shared-types';

import type { ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';

function serializeAccount(account: {
  id: string;
  type: AccountType;
  baseCurrency: string;
  balance: { toString(): string };
  initialBalance: { toString(): string };
  status: 'ACTIVE' | 'RESTRICTED' | 'CLOSED';
  createdAt: Date;
}): DemoAccountSummary {
  return {
    id: account.id,
    type: account.type,
    baseCurrency: account.baseCurrency,
    balance: account.balance.toString(),
    initialBalance: account.initialBalance.toString(),
    status: account.status,
    createdAt: account.createdAt.toISOString(),
  };
}

function serializeLedgerEntry(entry: {
  id: string;
  type: 'DEMO_CREDIT' | 'REALIZED_PNL' | 'FEE' | 'ADJUSTMENT';
  amount: { toString(): string };
  balanceAfter: { toString(): string };
  referenceType: string | null;
  createdAt: Date;
}): LedgerEntrySummary {
  return {
    id: entry.id,
    type: entry.type,
    amount: entry.amount.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    referenceType: entry.referenceType,
    createdAt: entry.createdAt.toISOString(),
  };
}

@Injectable()
export class AccountsService {
  constructor(private readonly database: DatabaseService) {}

  private async getActiveUserAndAccount(identity: ClerkIdentity) {
    const user = await this.database.client.user.findUnique({
      where: { clerkId: identity.clerkUserId },
      include: {
        accounts: {
          where: { type: AccountType.DEMO, baseCurrency: 'USD' },
          take: 1,
        },
      },
    });

    if (!user) {
      throw new NotFoundException({
        code: 'SESSION_NOT_BOOTSTRAPPED',
        message: 'Bootstrap the session before requesting an account',
      });
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This Excess account is suspended',
      });
    }

    const account = user.accounts[0];
    if (!account) {
      throw new NotFoundException({
        code: 'DEMO_ACCOUNT_NOT_FOUND',
        message: 'No demo account exists for this user',
      });
    }

    return { user, account };
  }

  async getDemoAccount(identity: ClerkIdentity): Promise<DemoAccountSummary> {
    const { account } = await this.getActiveUserAndAccount(identity);
    return serializeAccount(account);
  }

  async getLedger(
    identity: ClerkIdentity,
    options: { limit: number; cursor?: string },
  ): Promise<LedgerPage> {
    const { account } = await this.getActiveUserAndAccount(identity);

    if (options.cursor) {
      const cursorEntry = await this.database.client.ledgerEntry.findFirst({
        where: { id: options.cursor, accountId: account.id },
        select: { id: true },
      });
      if (!cursorEntry) {
        throw new BadRequestException({
          code: 'INVALID_LEDGER_CURSOR',
          message: 'The ledger cursor is invalid for this account',
        });
      }
    }

    const entries = await this.database.client.ledgerEntry.findMany({
      where: { accountId: account.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    const hasMore = entries.length > options.limit;
    const page = entries.slice(0, options.limit);

    return {
      items: page.map(serializeLedgerEntry),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
