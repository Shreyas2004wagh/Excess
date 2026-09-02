import Decimal from 'decimal.js';

export type FillSide = 'BUY' | 'SELL';

export interface ApplyFillInput {
  signedQuantity: string;
  averageEntryPrice: string | null;
  side: FillSide;
  quantity: string;
  fillPrice: string;
}

export interface PositionAfterFill {
  signedQuantity: string;
  averageEntryPrice: string | null;
  realizedPnlDelta: string;
}

function plain(value: Decimal) {
  return value.isZero() ? '0' : value.toFixed();
}

export function applyFillToPosition({
  signedQuantity,
  averageEntryPrice,
  side,
  quantity,
  fillPrice,
}: ApplyFillInput): PositionAfterFill {
  const currentQuantity = new Decimal(signedQuantity);
  const fillQuantity = new Decimal(quantity);
  const price = new Decimal(fillPrice);

  if (!fillQuantity.isPositive()) {
    throw new Error('Fill quantity must be positive');
  }
  if (!price.isPositive()) {
    throw new Error('Fill price must be positive');
  }
  if (!currentQuantity.isZero() && averageEntryPrice === null) {
    throw new Error('An open position requires an average entry price');
  }

  const signedFill = side === 'BUY' ? fillQuantity : fillQuantity.negated();
  const nextQuantity = currentQuantity.plus(signedFill);

  if (currentQuantity.isZero()) {
    return {
      signedQuantity: plain(nextQuantity),
      averageEntryPrice: plain(price),
      realizedPnlDelta: '0',
    };
  }

  const entryPrice = new Decimal(averageEntryPrice!);
  const sameDirection =
    currentQuantity.isPositive() === signedFill.isPositive();

  if (sameDirection) {
    const weightedEntry = currentQuantity
      .abs()
      .mul(entryPrice)
      .plus(fillQuantity.mul(price))
      .div(nextQuantity.abs());
    return {
      signedQuantity: plain(nextQuantity),
      averageEntryPrice: plain(weightedEntry),
      realizedPnlDelta: '0',
    };
  }

  const closingQuantity = Decimal.min(currentQuantity.abs(), fillQuantity);
  const direction = currentQuantity.isPositive()
    ? new Decimal(1)
    : new Decimal(-1);
  const realizedPnl = price
    .minus(entryPrice)
    .mul(closingQuantity)
    .mul(direction);
  const flipped =
    !nextQuantity.isZero() &&
    currentQuantity.isPositive() !== nextQuantity.isPositive();

  return {
    signedQuantity: plain(nextQuantity),
    averageEntryPrice: nextQuantity.isZero()
      ? null
      : flipped
        ? plain(price)
        : plain(entryPrice),
    realizedPnlDelta: plain(realizedPnl),
  };
}
