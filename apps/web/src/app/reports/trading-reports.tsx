'use client';

import { useAuth } from '@clerk/nextjs';
import {
  MARKET_SYMBOLS,
  type MarketSymbol,
  type TradingReport,
} from '@excess/shared-types';
import { useRef, useState, type FormEvent } from 'react';

import {
  ExcessApiError,
  exportTradingReport,
  getTradingReport,
} from '../../lib/excess-api';
import { formatCurrency } from '../../lib/format';

const money = (value: string) => formatCurrency(value, 'USD');
const pnlTone = (value: string) =>
  Number(value) < 0
    ? 'text-rose-300'
    : Number(value) > 0
      ? 'text-[var(--accent)]'
      : 'text-[var(--muted)]';
const fieldClass =
  'mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm [color-scheme:dark]';
const panelClass =
  'rounded-2xl border border-[var(--border)] bg-[var(--surface)]';

export function TradingReports({
  initialReport,
}: {
  initialReport: TradingReport;
}) {
  const { getToken } = useAuth();
  const [report, setReport] = useState(initialReport);
  const [from, setFrom] = useState(initialReport.filters.from);
  const [to, setTo] = useState(initialReport.filters.to);
  const [symbol, setSymbol] = useState<MarketSymbol | ''>(
    initialReport.filters.symbol ?? '',
  );
  const [busy, setBusy] = useState<'filter' | 'more' | 'export' | null>(null);
  const requestInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  async function run(
    action: 'filter' | 'more' | 'export',
    work: (token: string) => Promise<void>,
  ) {
    if (requestInFlight.current || blocked) return;
    requestInFlight.current = true;
    setBusy(action);
    setError(null);
    setDownloaded(false);
    try {
      const token = await getToken();
      if (!token) {
        window.location.assign('/sign-in');
        return;
      }
      await work(token);
    } catch (cause) {
      if (cause instanceof ExcessApiError && cause.status === 401) {
        window.location.assign('/sign-in');
        return;
      }
      if (cause instanceof ExcessApiError && cause.status === 403)
        setBlocked(true);
      setError(
        cause instanceof ExcessApiError
          ? cause.message
          : 'The report request failed. Please try again.',
      );
    } finally {
      requestInFlight.current = false;
      setBusy(null);
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = { from, to, ...(symbol ? { symbol } : {}) };
    void run('filter', async (token) => {
      const next = await getTradingReport(token, query);
      setReport(next);
      // Keep successful filters shareable and persistent on refresh.
      window.history.replaceState(
        null,
        '',
        `/reports?${new URLSearchParams(query)}`,
      );
    });
  }

  function appliedQuery() {
    const { symbol: selected, ...filters } = report.filters;
    return { ...filters, ...(selected ? { symbol: selected } : {}) };
  }

  function loadMore() {
    const cursor = report.trades.nextCursor;
    if (!cursor) return;
    void run('more', async (token) => {
      const next = await getTradingReport(token, { ...appliedQuery(), cursor });
      setReport({
        ...next,
        trades: {
          ...next.trades,
          items: [...report.trades.items, ...next.trades.items],
        },
      });
    });
  }

  function download() {
    void run('export', async (token) => {
      const blob = await exportTradingReport(token, appliedQuery());
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `excess-trades-${report.filters.from}-${report.filters.to}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Let the browser consume the object URL before releasing it.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloaded(true);
    });
  }

  return (
    <section className="py-10">
      <p className="font-mono text-xs uppercase tracking-[0.24em] text-[var(--accent)]">
        Demo account · USD
      </p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Trading reports
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">
            Review your executions and credited realized results. All dates and
            times are UTC.
          </p>
        </div>
        <button
          className="button button-secondary"
          disabled={!!busy || blocked}
          onClick={download}
          type="button"
        >
          {busy === 'export' ? 'Preparing CSV…' : 'Export CSV'}
        </button>
      </div>

      <form
        className={`${panelClass} mt-7 flex flex-wrap items-end gap-4 p-5`}
        onSubmit={applyFilters}
      >
        <label className="min-w-40 flex-1 text-sm">
          From (UTC)
          <input
            className={fieldClass}
            name="from"
            type="date"
            required
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="min-w-40 flex-1 text-sm">
          To (UTC)
          <input
            className={fieldClass}
            name="to"
            type="date"
            required
            min={from}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <label className="min-w-40 flex-1 text-sm">
          Instrument
          <select
            className={fieldClass}
            name="symbol"
            value={symbol}
            onChange={(event) =>
              setSymbol(event.target.value as MarketSymbol | '')
            }
          >
            <option value="">All instruments</option>
            {MARKET_SYMBOLS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button button-primary"
          disabled={!!busy || blocked}
          type="submit"
        >
          {busy === 'filter' ? 'Loading…' : 'Apply filters'}
        </button>
        <p className="w-full text-xs text-[var(--muted)]">
          Up to 366 days per report. CSV includes every matching execution, up
          to 10,000 rows.
        </p>
      </form>

      {error ? (
        <p
          className="mt-4 rounded-xl border border-rose-300/30 p-4 text-sm text-rose-300"
          role="alert"
        >
          {error}
          {blocked
            ? ' Contact support for account access.'
            : ' The previous report is still displayed; retry the action when ready.'}
        </p>
      ) : null}
      {downloaded ? (
        <p className="mt-4 text-sm text-[var(--accent)]" role="status">
          CSV download started for the applied filters.
        </p>
      ) : null}
      <p
        className="mt-6 text-sm text-[var(--muted)]"
        data-testid="report-range"
      >
        Showing {report.filters.from} through {report.filters.to} ·{' '}
        {report.filters.symbol ?? 'All instruments'} · Execution cutoff:{' '}
        {report.filters.asOf.replace('T', ' ').replace('Z', ' UTC')}
      </p>
      <div
        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="report-summary"
        aria-busy={busy === 'filter'}
      >
        {[
          ['Executions', String(report.summary.executions)],
          ['Traded notional', money(report.summary.tradedNotional)],
          ['Recorded fees', money(report.summary.fees)],
          ['Credited realized P/L', money(report.summary.creditedRealizedPnl)],
        ].map(([label, value]) => (
          <article className={`${panelClass} p-5`} key={label}>
            <h2 className="text-sm text-[var(--muted)]">{label}</h2>
            <p
              className={`mt-3 break-words font-mono text-2xl ${label === 'Credited realized P/L' ? pnlTone(report.summary.creditedRealizedPnl) : ''}`}
            >
              {value}
            </p>
          </article>
        ))}
      </div>
      <p className="mt-4 max-w-4xl text-xs leading-6 text-[var(--muted)]">
        Realized P/L uses the amounts applied to your ledger, including
        negative-balance protection. It excludes unrealized P/L, the opening
        demo credit, and adjustments; fees are shown separately. Cumulative
        results start at zero for this period and are not an equity curve.
        Displays round USD to cents; CSV preserves full precision.
      </p>

      <article className={`${panelClass} mt-7 overflow-hidden`}>
        <h2 className="border-b border-[var(--border)] px-5 py-4 font-semibold">
          Daily realized results
        </h2>
        <div
          className="max-h-96 overflow-auto"
          tabIndex={0}
          role="region"
          aria-label="Daily realized results table"
        >
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="sticky top-0 bg-[var(--surface)] text-xs text-[var(--muted)]">
              <tr>
                {[
                  'Date (UTC)',
                  'Executions',
                  'Notional',
                  'Realized P/L',
                  'Cumulative P/L',
                ].map((label) => (
                  <th className="px-5 py-3 font-medium" key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...report.days].reverse().map((day) => (
                <tr
                  className="border-t border-[var(--border)] font-mono"
                  key={day.date}
                >
                  <th className="px-5 py-3 font-normal" scope="row">
                    {day.date}
                  </th>
                  <td className="px-5 py-3">{day.executions}</td>
                  <td className="px-5 py-3">{money(day.tradedNotional)}</td>
                  <td
                    className={`px-5 py-3 ${pnlTone(day.creditedRealizedPnl)}`}
                  >
                    {money(day.creditedRealizedPnl)}
                  </td>
                  <td
                    className={`px-5 py-3 ${pnlTone(day.cumulativeRealizedPnl)}`}
                  >
                    {money(day.cumulativeRealizedPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      <article
        className={`${panelClass} mt-5 overflow-hidden`}
        data-testid="report-trades"
      >
        <div className="flex flex-wrap justify-between gap-2 border-b border-[var(--border)] px-5 py-4">
          <h2 className="font-semibold">Execution history</h2>
          <p className="text-xs text-[var(--muted)]">
            {report.trades.items.length} of {report.summary.executions}{' '}
            executions · Newest first
          </p>
        </div>
        {report.trades.items.length ? (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Execution history table"
          >
            <table className="w-full whitespace-nowrap text-left text-sm">
              <thead className="text-xs text-[var(--muted)]">
                <tr>
                  {[
                    'Executed (UTC)',
                    'Instrument',
                    'Side / type',
                    'Purpose',
                    'Quantity',
                    'Fill price',
                    'Leverage',
                    'Fee',
                    'Realized P/L',
                  ].map((label) => (
                    <th
                      className="px-5 py-3 font-medium"
                      key={label}
                      scope="col"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.trades.items.map((trade) => (
                  <tr
                    className="border-t border-[var(--border)] font-mono text-xs"
                    key={trade.id}
                  >
                    <td className="px-5 py-4">
                      {trade.executedAt.replace('T', ' ').replace('Z', '')}
                    </td>
                    <td className="px-5 py-4">{trade.symbol}</td>
                    <td className="px-5 py-4">
                      {trade.side} / {trade.orderType}
                    </td>
                    <td className="px-5 py-4">
                      {trade.purpose.replaceAll('_', ' ')}
                    </td>
                    <td className="px-5 py-4">{trade.quantity}</td>
                    <td className="px-5 py-4">{money(trade.price)}</td>
                    <td className="px-5 py-4">{trade.leverage}×</td>
                    <td className="px-5 py-4">{money(trade.fee)}</td>
                    <td
                      className={`px-5 py-4 ${pnlTone(trade.realizedPnl ?? '0')}`}
                    >
                      {trade.realizedPnl === null
                        ? '—'
                        : money(trade.realizedPnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-8 text-sm text-[var(--muted)]">
            No executions match these filters. Try another period or instrument.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border)] px-5 py-4">
          <p className="text-xs text-[var(--muted)]">
            — means no realized ledger entry was recorded for that execution.
          </p>
          {report.trades.nextCursor ? (
            <button
              className="button button-secondary"
              disabled={!!busy || blocked}
              onClick={loadMore}
              type="button"
            >
              {busy === 'more' ? 'Loading…' : 'Load more executions'}
            </button>
          ) : null}
        </div>
      </article>
    </section>
  );
}
