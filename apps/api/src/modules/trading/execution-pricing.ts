import { Prisma } from '@excess/database';
import {
  SIMULATED_SLIPPAGE_BPS,
  type MarketTicker,
  type OrderSide,
  type OrderType,
} from '@excess/shared-types';

type ExecutionPriceInput = {
  ticker: Pick<MarketTicker, 'bid' | 'ask'>;
  side: OrderSide;
  type: OrderType;
  tickSize: Prisma.Decimal;
};

/** Spread belongs to the quote; slippage is the additional adverse move from it. */
export function executionPrice({
  ticker,
  side,
  type,
  tickSize,
}: ExecutionPriceInput) {
  const bid = new Prisma.Decimal(ticker.bid);
  const ask = new Prisma.Decimal(ticker.ask);
  if (
    bid.lessThanOrEqualTo(0) ||
    ask.lessThan(bid) ||
    tickSize.lessThanOrEqualTo(0)
  ) {
    throw new RangeError('Invalid executable quote or tick size');
  }
  const quote = side === 'BUY' ? ask : bid;
  const mid = bid.plus(ask).div(2);
  let fill = quote;
  if (type !== 'LIMIT') {
    const direction = side === 'BUY' ? 1 : -1;
    const target = quote.mul(
      new Prisma.Decimal(1).plus(
        new Prisma.Decimal(direction).mul(SIMULATED_SLIPPAGE_BPS).div(10_000),
      ),
    );
    const rounded = target
      .div(tickSize)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .mul(tickSize);
    fill =
      side === 'BUY'
        ? Prisma.Decimal.max(quote, rounded)
        : Prisma.Decimal.min(quote, rounded);
    // A quote below one tick can round a sell to zero; preserve the positive quote.
    if (fill.lessThanOrEqualTo(0)) fill = quote;
  }

  return {
    fillPrice: fill,
    spreadBps: quote.minus(mid).abs().div(mid).mul(10_000).toDecimalPlaces(6),
    slippageBps: fill
      .minus(quote)
      .abs()
      .div(quote)
      .mul(10_000)
      .toDecimalPlaces(6),
  };
}
