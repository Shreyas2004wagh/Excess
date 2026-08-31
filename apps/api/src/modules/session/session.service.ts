import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AccountType,
  Prisma,
  UserStatus,
  type Account,
  type User,
} from '@excess/database';
import type { SessionBootstrapResponse } from '@excess/shared-types';

import { CLERK_GATEWAY } from '../auth/auth.tokens.js';
import type { ClerkGateway, ClerkIdentity } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';

const OPENING_BALANCE = new Prisma.Decimal('10000');
const MAX_TRANSACTION_ATTEMPTS = 8;

function serialize(user: User, account: Account): SessionBootstrapResponse {
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
    },
    account: {
      id: account.id,
      type: account.type,
      baseCurrency: account.baseCurrency,
      balance: account.balance.toString(),
      initialBalance: account.initialBalance.toString(),
      status: account.status,
      createdAt: account.createdAt.toISOString(),
    },
  };
}

function isRetryableTransactionError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002')
  );
}

@Injectable()
export class SessionService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(CLERK_GATEWAY) private readonly clerk: ClerkGateway,
  ) {}

  async bootstrap(identity: ClerkIdentity): Promise<SessionBootstrapResponse> {
    const profile = await this.clerk.getUserProfile(identity.clerkUserId);
    if (!profile.email) {
      throw new UnprocessableEntityException({
        code: 'IDENTITY_EMAIL_REQUIRED',
        message: 'A verified primary email address is required',
      });
    }
    const email = profile.email;

    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.client.$transaction(
          async (transaction) => {
            const user = await transaction.user.upsert({
              where: { clerkId: profile.clerkUserId },
              create: {
                clerkId: profile.clerkUserId,
                email,
                displayName: profile.displayName,
              },
              update: {
                email,
                displayName: profile.displayName,
              },
            });

            if (user.status === UserStatus.SUSPENDED) {
              throw new ForbiddenException({
                code: 'ACCOUNT_SUSPENDED',
                message: 'This Excess account is suspended',
              });
            }

            const existingAccount = await transaction.account.findUnique({
              where: {
                userId_type_baseCurrency: {
                  userId: user.id,
                  type: AccountType.DEMO,
                  baseCurrency: 'USD',
                },
              },
            });

            const account =
              existingAccount ??
              (await transaction.account.create({
                data: {
                  userId: user.id,
                  type: AccountType.DEMO,
                  baseCurrency: 'USD',
                  balance: OPENING_BALANCE,
                  initialBalance: OPENING_BALANCE,
                  ledgerEntries: {
                    create: {
                      type: 'DEMO_CREDIT',
                      amount: OPENING_BALANCE,
                      balanceAfter: OPENING_BALANCE,
                      referenceType: 'DEMO_ACCOUNT_OPENING',
                      referenceId: profile.clerkUserId,
                      idempotencyKey: `demo-opening:${profile.clerkUserId}:USD`,
                    },
                  },
                },
              }));

            return serialize(user, account);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (
          !isRetryableTransactionError(error) ||
          attempt === MAX_TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
        const backoff = 10 * 2 ** (attempt - 1);
        await delay(backoff + Math.floor(Math.random() * backoff));
      }
    }

    throw new ServiceUnavailableException(
      'Could not provision the demo account',
    );
  }
}
import { setTimeout as delay } from 'node:timers/promises';
