import { describe, expect, it } from 'vitest';

import { calculateUnrealizedPnl } from './pnl';

describe('calculateUnrealizedPnl', () => {
  it('calculates profit for a long position', () => {
    expect(
      calculateUnrealizedPnl({
        averageEntryPrice: '60000',
        markPrice: '61000',
        signedQuantity: '0.1',
      }),
    ).toBe('100');
  });

  it('calculates profit for a short position', () => {
    expect(
      calculateUnrealizedPnl({
        averageEntryPrice: '61000',
        markPrice: '60000',
        signedQuantity: '-0.1',
      }),
    ).toBe('100');
  });
});
