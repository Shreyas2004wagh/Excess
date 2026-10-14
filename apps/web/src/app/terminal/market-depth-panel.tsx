import type {
  MarketDataStatus,
  MarketDataSource,
  MarketOrderBook,
  MarketSymbol,
  OrderBookLevel,
} from '@excess/shared-types';

const priceFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const quantityFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 8,
});

function cumulativeLevels(levels: OrderBookLevel[]) {
  let total = 0;
  return levels.slice(0, 10).map((level) => {
    total += Number(level.quantity);
    return { ...level, total };
  });
}

export function MarketDepthPanel({
  book,
  symbol,
  baseCurrency,
  feedStatus,
  source,
}: {
  book: MarketOrderBook | null;
  symbol: MarketSymbol;
  baseCurrency: string;
  feedStatus: MarketDataStatus;
  source: MarketDataSource;
}) {
  const bids = cumulativeLevels(book?.bids ?? []);
  const asks = cumulativeLevels(book?.asks ?? []);
  const maximumTotal = Math.max(
    bids.at(-1)?.total ?? 0,
    asks.at(-1)?.total ?? 0,
    0.00000001,
  );
  const status =
    book?.status ?? (feedStatus === 'OFFLINE' ? 'OFFLINE' : 'CONNECTING');
  const hasLevels = bids.length > 0 || asks.length > 0;
  const spread =
    bids[0] && asks[0] ? Number(asks[0].price) - Number(bids[0].price) : null;

  return (
    <section
      aria-label={`${symbol} market depth`}
      className="border-t border-[var(--border)] px-5 py-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Order book</h2>
          <p className="mt-1 text-[11px] text-[var(--muted)]">
            {(book?.source ?? source) === 'SIMULATED'
              ? 'Simulated market'
              : 'Coinbase'}
            {' · '}
            {symbol.replace('-', ' / ')}
            {' · '}Nearest 10 levels
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          {spread !== null ? (
            <span className="text-[var(--muted)]">
              Spread{' '}
              <span className="font-mono text-[var(--foreground)]">
                ${priceFormat.format(spread)}
              </span>
            </span>
          ) : null}
          <span
            className={
              status === 'LIVE' && hasLevels
                ? 'text-[var(--accent)]'
                : status === 'STALE'
                  ? 'text-amber-300'
                  : 'text-[var(--muted)]'
            }
          >
            {status === 'LIVE' && hasLevels
              ? 'Live'
              : status === 'STALE'
                ? 'Stale'
                : status === 'OFFLINE'
                  ? 'Offline'
                  : 'Connecting'}
          </span>
        </div>
      </div>

      {hasLevels ? (
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          {(
            [
              [
                'Bids',
                bids,
                'text-[var(--accent)]',
                'rgba(182, 237, 114, 0.08)',
              ],
              ['Asks', asks, 'text-rose-300', 'rgba(243, 138, 155, 0.08)'],
            ] as const
          ).map(([name, levels, color, background]) => (
            <div key={name}>
              <h3 className={`mb-2 text-xs font-medium ${color}`}>{name}</h3>
              <table
                aria-label={`${name} for ${symbol}`}
                className="w-full table-fixed text-right text-[11px]"
              >
                <thead className="text-[var(--muted)]">
                  <tr>
                    <th className="pb-2 text-left font-normal" scope="col">
                      Price (USD)
                    </th>
                    <th className="pb-2 font-normal" scope="col">
                      Size ({baseCurrency})
                    </th>
                    <th className="pb-2 font-normal" scope="col">
                      Total ({baseCurrency})
                    </th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {levels.map((level) => {
                    const width = (level.total / maximumTotal) * 100;
                    return (
                      <tr
                        key={level.price}
                        style={{
                          background: `linear-gradient(to left, ${background} ${width}%, transparent ${width}%)`,
                        }}
                      >
                        <td className={`py-1.5 text-left ${color}`}>
                          {priceFormat.format(Number(level.price))}
                        </td>
                        <td className="py-1.5">
                          {quantityFormat.format(Number(level.quantity))}
                        </td>
                        <td className="py-1.5 text-[var(--muted)]">
                          {quantityFormat.format(level.total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--muted)]">
          {status === 'OFFLINE'
            ? 'Market depth will return when the feed reconnects.'
            : 'Waiting for a fresh order book…'}
        </p>
      )}
      <p className="mt-4 text-[10px] leading-4 text-[var(--muted)]">
        Depth is informational. Demo orders follow the simulator’s fill model.
      </p>
    </section>
  );
}
