import { jest } from '@jest/globals';
import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@excess/database';

import type { DatabaseService } from '../database/database.service.js';
import { ReportsController } from './reports.controller.js';
import { parseReportQuery } from './report-query.js';
import { MAX_EXPORT_ROWS, ReportsService } from './reports.service.js';

describe('Report export safeguards', () => {
  const identity = { clerkUserId: 'user_export', sessionId: 'session_export' };

  function setup(rows: unknown[]) {
    const findMany = jest.fn(async () => rows);
    const tx = {
      user: {
        findUnique: jest.fn(async () => ({
          status: 'ACTIVE',
          identityDeletedAt: null,
          accounts: [{ id: 'account', status: 'ACTIVE' }],
        })),
      },
      trade: { findMany },
      ledgerEntry: { groupBy: jest.fn(async () => []) },
    };
    const database = {
      client: {
        $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
      },
    } as unknown as DatabaseService;
    return { reports: new ReportsService(database), findMany };
  }

  it('rejects oversized exports rather than silently truncating them', async () => {
    const { reports, findMany } = setup(
      Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => ({})),
    );
    await expect(
      reports.exportCsv(identity, parseReportQuery({})),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: MAX_EXPORT_ROWS + 1 }),
    );
  });

  it('escapes formula-like text and embedded CSV delimiters', async () => {
    const zero = new Prisma.Decimal(0);
    const { reports } = setup([
      {
        id: 'id',
        orderId: 'order',
        instrument: { symbol: '=BAD,"quote"' },
        side: 'BUY',
        price: new Prisma.Decimal('100'),
        quantity: new Prisma.Decimal('0.1'),
        fee: zero,
        spreadBps: zero,
        slippageBps: zero,
        executedAt: new Date(),
        order: {
          type: 'MARKET',
          purpose: 'ENTRY',
          leverage: new Prisma.Decimal(1),
        },
      },
    ]);
    expect(await reports.exportCsv(identity, parseReportQuery({}))).toContain(
      '"\'=BAD,""quote"""',
    );
  });

  it('sets a safe download filename and rejects export pagination', async () => {
    const { reports } = setup([]);
    const controller = new ReportsController(reports);
    const response = { setHeader: jest.fn() } as unknown as Response;
    await controller.exportCsv(
      identity,
      { from: '2024-01-01', to: '2024-01-31' },
      response,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="excess-trades-2024-01-01-2024-01-31.csv"',
    );
    await expect(
      controller.exportCsv(identity, { limit: '20' }, response),
    ).rejects.toThrow(BadRequestException);
  });
});
