import Decimal from 'decimal.js';

export interface AccountMetricsInput {
  balance: string;
  unrealizedPnl: string;
  usedMargin: string;
}

export interface AccountMetrics {
  equity: string;
  freeMargin: string;
  marginLevel: string | null;
}

export function calculateAccountMetrics({
  balance,
  unrealizedPnl,
  usedMargin,
}: AccountMetricsInput): AccountMetrics {
  const equity = new Decimal(balance).plus(unrealizedPnl);
  const margin = new Decimal(usedMargin);

  return {
    equity: equity.toFixed(),
    freeMargin: equity.minus(margin).toFixed(),
    marginLevel: margin.isZero() ? null : equity.div(margin).mul(100).toFixed(),
  };
}
