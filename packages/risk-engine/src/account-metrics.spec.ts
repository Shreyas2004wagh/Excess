import { describe, expect, it } from 'vitest';

import {
  calculateAccountMetrics,
  calculatePositionMargin,
  classifyRisk,
} from './account-metrics';

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
      usedMargin: '2000',
      freeMargin: '8250',
      marginLevel: '512.5',
      riskState: 'HEALTHY',
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

  it('calculates position margin from leverage', () => {
    expect(
      calculatePositionMargin({
        signedQuantity: '-1.5',
        markPrice: '60000',
        leverage: '10',
      }),
    ).toBe('9000');
  });

  it.each([
    [null, 'HEALTHY'],
    ['100.01', 'HEALTHY'],
    ['100', 'MARGIN_WARNING'],
    ['50.01', 'MARGIN_WARNING'],
    ['50', 'LIQUIDATION'],
    ['-1', 'LIQUIDATION'],
  ] as const)('classifies a %s margin level as %s', (level, expected) => {
    expect(classifyRisk(level)).toBe(expected);
  });
});
