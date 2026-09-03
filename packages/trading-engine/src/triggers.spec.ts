import { describe, expect, it } from 'vitest';

import { shouldTriggerPendingOrder } from './triggers';

describe('shouldTriggerPendingOrder', () => {
  it.each([
    ['BUY', 'LIMIT', '99', null, '98', '98.5', true],
    ['BUY', 'LIMIT', '99', null, '99', '99.5', false],
    ['SELL', 'LIMIT', '101', null, '101', '101.5', true],
    ['SELL', 'LIMIT', '101', null, '100.5', '101', false],
    ['BUY', 'STOP', null, '101', '100.5', '101', true],
    ['BUY', 'STOP', null, '101', '100', '100.5', false],
    ['SELL', 'STOP', null, '99', '99', '99.5', true],
    ['SELL', 'STOP', null, '99', '99.5', '100', false],
  ] as const)(
    'evaluates %s %s trigger rules',
    (side, type, requestedPrice, stopPrice, bid, ask, expected) => {
      expect(
        shouldTriggerPendingOrder({
          side,
          type,
          requestedPrice,
          stopPrice,
          bid,
          ask,
        }),
      ).toBe(expected);
    },
  );
});
