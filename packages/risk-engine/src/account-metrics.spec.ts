import { describe, expect, it } from 'vitest';

import { calculateAccountMetrics } from './account-metrics';

describe('calculateAccountMetrics', () => {
  it('calculates equity and available margin', () => {
    expect(
      calculateAccountMetrics({
        balance: '10000',
        unrealizedPnl: '250',
        usedMargin: '2000',
      }),
    ).toEqual({
      equity: '10250',
      freeMargin: '8250',
      marginLevel: '512.5',
    });
  });

  it('does not report a margin level without used margin', () => {
    expect(
      calculateAccountMetrics({
        balance: '10000',
        unrealizedPnl: '0',
        usedMargin: '0',
      }).marginLevel,
    ).toBeNull();
  });
});
