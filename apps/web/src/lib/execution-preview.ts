import { SIMULATED_SLIPPAGE_BPS, type OrderSide } from '@excess/shared-types';

/** Display-only estimate. The API recalculates the fill from its latest quote. */
export function estimateMarketFill(
  quote: string,
  side: OrderSide,
  tickSize: string,
  pricePrecision: number,
) {
  const price = Number(quote);
  const tick = Number(tickSize);
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(tick) ||
    tick <= 0
  ) {
    return quote;
  }
  const direction = side === 'BUY' ? 1 : -1;
  const target = price * (1 + (direction * SIMULATED_SLIPPAGE_BPS) / 10_000);
  const rounded = Math.round(target / tick) * tick;
  if (rounded <= 0) return price.toFixed(pricePrecision);
  const adverse =
    side === 'BUY' ? Math.max(price, rounded) : Math.min(price, rounded);
  return adverse.toFixed(pricePrecision);
}
