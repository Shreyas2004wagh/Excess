import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { WebhookEvent } from '@clerk/backend';
import type { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';

import type { ClerkGateway } from '../auth/auth.types.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { ClerkWebhookVerifier } from '../webhooks/webhook-verifier.types.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';
import { SessionService } from './session.service.js';

const clerkUserId = `user_test_${randomUUID()}`;
const identity = { clerkUserId, sessionId: 'session_test' };

describe('Milestone 1 account lifecycle', () => {
  const database = new DatabaseService();
  const clerk = {
    getUserProfile: jest.fn(async () => ({
      clerkUserId,
      email: 'trader+clerk_test@example.com',
      displayName: 'Test Trader',
    })),
  } as unknown as ClerkGateway;
  const session = new SessionService(database, clerk);
  const accounts = new AccountsService(database);

  beforeAll(async () => database.onModuleInit());

  afterAll(async () => {
    const user = await database.client.user.findUnique({
      where: { clerkId: clerkUserId },
    });
    if (user) {
      await database.client.$transaction([
        database.client.ledgerEntry.deleteMany({
          where: { account: { userId: user.id } },
        }),
        database.client.account.deleteMany({ where: { userId: user.id } }),
        database.client.auditEvent.deleteMany({
          where: { actorUserId: user.id },
        }),
        database.client.user.delete({ where: { id: user.id } }),
      ]);
    }
    await database.onModuleDestroy();
  });

  it('requires a verified primary email', async () => {
    const clerkWithoutEmail = {
      getUserProfile: jest.fn(async () => ({
        clerkUserId: 'user_without_email',
        email: null,
        displayName: null,
      })),
    } as unknown as ClerkGateway;

    await expect(
      new SessionService(database, clerkWithoutEmail).bootstrap({
        clerkUserId: 'user_without_email',
        sessionId: 'session_without_email',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('provisions exactly one user, account, and opening credit under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => session.bootstrap(identity)),
    );

    expect(new Set(results.map((result) => result.account.id)).size).toBe(1);
    expect(results[0]?.account).toMatchObject({
      balance: '10000',
      initialBalance: '10000',
      baseCurrency: 'USD',
      type: 'DEMO',
    });
    expect(results[0]?.user.role).toBe('TRADER');

    const user = await database.client.user.findUniqueOrThrow({
      where: { clerkId: clerkUserId },
      include: { accounts: { include: { ledgerEntries: true } } },
    });
    expect(user.accounts).toHaveLength(1);
    expect(user.accounts[0]?.ledgerEntries).toHaveLength(1);
    expect(user.accounts[0]?.ledgerEntries[0]).toMatchObject({
      type: 'DEMO_CREDIT',
      idempotencyKey: `demo-opening:${clerkUserId}:USD`,
    });
  });

  it('never resets an existing balance during bootstrap', async () => {
    const first = await session.bootstrap(identity);
    await database.client.account.update({
      where: { id: first.account.id },
      data: { balance: '9250' },
    });

    const repeated = await session.bootstrap(identity);
    expect(repeated.account.balance).toBe('9250');
    expect(
      await database.client.ledgerEntry.count({
        where: { accountId: first.account.id, type: 'DEMO_CREDIT' },
      }),
    ).toBe(1);
  });

  it('serializes account decimals and paginates the ledger newest first', async () => {
    const account = await accounts.getDemoAccount(identity);
    await database.client.ledgerEntry.createMany({
      data: [
        {
          accountId: account.id,
          type: 'ADJUSTMENT',
          amount: '25',
          balanceAfter: '9275',
          idempotencyKey: `test-adjustment-a:${clerkUserId}`,
        },
        {
          accountId: account.id,
          type: 'ADJUSTMENT',
          amount: '-25',
          balanceAfter: '9250',
          idempotencyKey: `test-adjustment-b:${clerkUserId}`,
        },
      ],
    });

    expect(account.balance).toBe('9250');
    const firstPage = await accounts.getLedger(identity, { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await accounts.getLedger(identity, {
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    await expect(
      accounts.getLedger(identity, { limit: 2, cursor: randomUUID() }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid webhooks and deactivates a deleted Clerk user idempotently', async () => {
    const verify = jest.fn<ClerkWebhookVerifier['verify']>();
    verify.mockRejectedValueOnce(new Error('invalid signature'));
    const verifier = { verify } as ClerkWebhookVerifier;
    const config = {
      get: jest.fn().mockReturnValue('whsec_test'),
    } as unknown as ConfigService;
    const webhooks = new WebhooksService(config, database, verifier);
    const request = new Request('http://localhost/api/v1/webhooks/clerk', {
      method: 'POST',
      body: '{}',
    });

    await expect(webhooks.handleClerkWebhook(request)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    verify
      .mockResolvedValueOnce({
        type: 'user.updated',
        data: {
          id: clerkUserId,
          primary_email_address_id: 'email_primary',
          email_addresses: [
            { id: 'email_primary', email_address: 'updated@example.com' },
          ],
          first_name: 'Updated',
          last_name: 'Trader',
        },
      } as unknown as WebhookEvent)
      .mockResolvedValue({
        type: 'user.deleted',
        data: { id: clerkUserId },
      } as unknown as WebhookEvent);

    await webhooks.handleClerkWebhook(request);
    await webhooks.handleClerkWebhook(request);
    const firstDeletion = await database.client.user.findUniqueOrThrow({
      where: { clerkId: clerkUserId },
      select: { identityDeletedAt: true },
    });
    await webhooks.handleClerkWebhook(request);

    const user = await database.client.user.findUniqueOrThrow({
      where: { clerkId: clerkUserId },
      include: { accounts: { include: { ledgerEntries: true } } },
    });
    expect(user).toMatchObject({
      email: 'updated@example.com',
      displayName: 'Updated Trader',
      status: 'SUSPENDED',
    });
    expect(user.identityDeletedAt).toBeInstanceOf(Date);
    expect(user.identityDeletedAt).toEqual(firstDeletion.identityDeletedAt);
    expect(user.accounts).toHaveLength(1);
    expect(user.accounts[0]?.ledgerEntries).toHaveLength(3);

    await expect(accounts.getDemoAccount(identity)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
