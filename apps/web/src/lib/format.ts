import type { LedgerEntrySummary } from '@excess/shared-types';

export function formatCurrency(value: string, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

export function formatSignedCurrency(value: string, currency: string) {
  return `${Number(value) > 0 ? '+' : ''}${formatCurrency(value, currency)}`;
}

export function ledgerLabel(type: LedgerEntrySummary['type']) {
  const labels: Record<LedgerEntrySummary['type'], string> = {
    DEMO_CREDIT: 'Opening demo credit',
    REALIZED_PNL: 'Realized trading P/L',
    FEE: 'Trading fee',
    ADJUSTMENT: 'Balance adjustment',
  };
  return labels[type];
}
