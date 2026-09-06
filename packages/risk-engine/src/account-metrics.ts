import Decimal from 'decimal.js';

export interface AccountMetricsInput {
  balance: string;
  unrealizedPnl: string;
  usedMargin: string;
}

export type RiskState = 'HEALTHY' | 'MARGIN_WARNING' | 'LIQUIDATION';

export interface AccountMetrics {
  equity: string;
  usedMargin: string;
  freeMargin: string;
  marginLevel: string | null;
  riskState: RiskState;
}

export const MARGIN_WARNING_LEVEL = '100';
export const LIQUIDATION_LEVEL = '50';

export function calculatePositionMargin({
  signedQuantity,
  markPrice,
  leverage,
}: {
  signedQuantity: string;
  markPrice: string;
  leverage: string;
}) {
  return new Decimal(signedQuantity)
    .abs()
    .mul(markPrice)
    .div(leverage)
    .toFixed();
}

export function calculateAccountMetrics({
  balance,
  unrealizedPnl,
  usedMargin,
}: AccountMetricsInput): AccountMetrics {
  const equity = new Decimal(balance).plus(unrealizedPnl);
  const margin = new Decimal(usedMargin);
  const marginLevel = margin.isZero()
    ? null
    : equity.div(margin).mul(100).toFixed();
  const riskState = classifyRisk(marginLevel);

  return {
    equity: equity.toFixed(),
    usedMargin: margin.toFixed(),
    freeMargin: equity.minus(margin).toFixed(),
    marginLevel,
    riskState,
  };
}

export function classifyRisk(marginLevel: string | null): RiskState {
  if (marginLevel === null) return 'HEALTHY';
  const level = new Decimal(marginLevel);
  if (level.lessThanOrEqualTo(LIQUIDATION_LEVEL)) return 'LIQUIDATION';
  if (level.lessThanOrEqualTo(MARGIN_WARNING_LEVEL)) return 'MARGIN_WARNING';
  return 'HEALTHY';
}
