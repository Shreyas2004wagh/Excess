import Decimal from 'decimal.js';

export interface UnrealizedPnlInput {
  averageEntryPrice: string;
  markPrice: string;
  signedQuantity: string;
}

export function calculateUnrealizedPnl({
  averageEntryPrice,
  markPrice,
  signedQuantity,
}: UnrealizedPnlInput): string {
  const entry = new Decimal(averageEntryPrice);
  const mark = new Decimal(markPrice);
  const quantity = new Decimal(signedQuantity);

  return mark.minus(entry).mul(quantity).toFixed();
}
