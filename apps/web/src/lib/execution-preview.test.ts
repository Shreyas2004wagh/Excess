import { describe, expect, it } from 'vitest';
import { estimateMarketFill } from './execution-preview';

describe('market fill preview', () => {
  it('shows the rounded adverse fill for a buy and sell', () => {
    expect(estimateMarketFill('65000.5', 'BUY', '0.01', 2)).toBe('65013.50');
    expect(estimateMarketFill('64999.5', 'SELL', '0.01', 2)).toBe('64986.50');
  });

  it('never improves the displayed quote when the slippage is smaller than a tick', () => {
    expect(estimateMarketFill('0.5', 'SELL', '0.01', 2)).toBe('0.50');
    expect(estimateMarketFill('0.004', 'SELL', '0.01', 3)).toBe('0.004');
  });
});
