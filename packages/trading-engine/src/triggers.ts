import Decimal from 'decimal.js';

export interface PendingOrderTriggerInput {
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'STOP';
  requestedPrice: string | null;
  stopPrice: string | null;
  bid: string;
  ask: string;
}

export function shouldTriggerPendingOrder({
  side,
  type,
  requestedPrice,
  stopPrice,
  bid,
  ask,
}: PendingOrderTriggerInput) {
  const executablePrice = new Decimal(side === 'BUY' ? ask : bid);
  if (type === 'LIMIT') {
    if (!requestedPrice) throw new Error('A limit order requires a price');
    const limit = new Decimal(requestedPrice);
    return side === 'BUY'
      ? executablePrice.lessThanOrEqualTo(limit)
      : executablePrice.greaterThanOrEqualTo(limit);
  }

  if (!stopPrice) throw new Error('A stop order requires a trigger price');
  const stop = new Decimal(stopPrice);
  return side === 'BUY'
    ? executablePrice.greaterThanOrEqualTo(stop)
    : executablePrice.lessThanOrEqualTo(stop);
}
