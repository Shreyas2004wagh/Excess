import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { jest } from '@jest/globals';
import { TradingController } from './trading.controller.js';
import type { TradingService } from './trading.service.js';

describe('Position close request validation', () => {
  const identity = { clerkUserId: 'user_close', sessionId: 'session_close' };
  const closePosition = jest.fn(async () => ({ order: {} }));
  const controller = new TradingController({
    closePosition,
  } as unknown as TradingService);
  const id = randomUUID();
  const valid = { clientOrderId: randomUUID(), expectedVersion: 0 };

  it.each([
    null,
    {},
    { ...valid, expectedVersion: -1 },
    { ...valid, expectedVersion: 0.1 },
    { ...valid, expectedVersion: '0' },
    { ...valid, expectedVersion: 2_147_483_648 },
    { ...valid, clientOrderId: 'invalid' },
    { ...valid, quantity: '1' },
    { ...valid, side: 'BUY' },
    { ...valid, leverage: 10 },
  ])('rejects malformed or client-sized requests: %j', (body) => {
    expect(() => controller.closePosition(identity, id, body)).toThrow(
      BadRequestException,
    );
  });
  it('rejects malformed position identifiers', () => {
    expect(() => controller.closePosition(identity, 'invalid', valid)).toThrow(
      BadRequestException,
    );
  });
  it('delegates a validated version and request key', async () => {
    await controller.closePosition(identity, id, valid);
    expect(closePosition).toHaveBeenCalledWith(identity, id, valid);
  });
});
