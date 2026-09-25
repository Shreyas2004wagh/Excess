import { describe, expect, it } from 'vitest';
import { formatSignedCurrency, ledgerLabel } from './format';

describe('Financial display labels', () => {
  it('only prefixes positive amounts and never creates a double sign', () => {
    expect(formatSignedCurrency('10000', 'USD')).toBe('+$10,000.00');
    expect(formatSignedCurrency('-25.5', 'USD')).toBe('-$25.50');
    expect(formatSignedCurrency('0', 'USD')).toBe('$0.00');
  });
  it('distinguishes funding, realized P/L, fees, and adjustments', () => {
    expect(ledgerLabel('DEMO_CREDIT')).toBe('Opening demo credit');
    expect(ledgerLabel('REALIZED_PNL')).toBe('Realized trading P/L');
    expect(ledgerLabel('FEE')).toBe('Trading fee');
    expect(ledgerLabel('ADJUSTMENT')).toBe('Balance adjustment');
  });
});
