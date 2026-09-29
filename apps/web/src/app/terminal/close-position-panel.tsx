'use client';

import { useAuth } from '@clerk/nextjs';
import type {
  ClosePositionRequest,
  MarketTicker,
  OrderPlacementResponse,
  PositionSummary,
} from '@excess/shared-types';
import { useEffect, useRef, useState } from 'react';

import { closePosition, ExcessApiError } from '../../lib/excess-api';
import { formatCurrency, formatSignedCurrency } from '../../lib/format';

type Review = { position: PositionSummary; request: ClosePositionRequest };

export function ClosePositionPanel({
  position,
  ticker,
  pendingEntries,
  blocked,
  onClosed,
  onRefresh,
  onBusyChange,
}: {
  position: PositionSummary | undefined;
  ticker: MarketTicker;
  pendingEntries: number;
  blocked: boolean;
  onClosed: (receipt: OrderPlacementResponse) => void;
  onRefresh: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const { getToken } = useAuth();
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<OrderPlacementResponse | null>(null);
  const inFlight = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const reviewId = review?.request.clientOrderId;

  useEffect(() => {
    if (reviewId) cancelButton.current?.focus();
  }, [reviewId]);
  useEffect(() => {
    if (receipt) result.current?.focus();
  }, [receipt]);

  const changed = Boolean(
    review &&
    (position?.id !== review.position.id ||
      position?.version !== review.position.version),
  );
  const reviewed = review?.position;
  const side = reviewed?.signedQuantity.startsWith('-') ? 'BUY' : 'SELL';
  const quote = side === 'BUY' ? ticker.ask : ticker.bid;
  const quantity = reviewed?.signedQuantity.replace(/^-/, '') ?? '0';
  const estimatedPnl = reviewed
    ? String(
        (Number(quote) - Number(reviewed.averageEntryPrice)) *
          Number(reviewed.signedQuantity),
      )
    : '0';

  function beginReview() {
    if (!position || blocked || inFlight.current) return;
    setReview({
      position,
      request: {
        clientOrderId: crypto.randomUUID(),
        expectedVersion: position.version,
      },
    });
    setError(null);
    setReceipt(null);
    setUncertain(false);
  }

  async function confirm() {
    if (
      !review ||
      inFlight.current ||
      blocked ||
      (!uncertain && (changed || ticker.status !== 'LIVE'))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) {
        window.location.assign('/sign-in');
        return;
      }
      const response = await closePosition(
        token,
        review.position.id,
        review.request,
      );
      setReceipt(response);
      setReview(null);
      setUncertain(false);
      onClosed(response);
    } catch (cause) {
      if (cause instanceof ExcessApiError && cause.status === 401) {
        window.location.assign('/sign-in');
        return;
      }
      const unknownResult =
        !(cause instanceof ExcessApiError) || cause.status >= 500;
      setUncertain(unknownResult);
      setError(
        unknownResult
          ? 'The close result could not be confirmed. Retry uses the same request identifier and cannot close twice.'
          : cause.message,
      );
      if (!unknownResult) {
        setReview(null);
        await onRefresh().catch(() => undefined);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <div className="mt-4" aria-busy={busy}>
      {receipt?.trade && (
        <p
          ref={result}
          tabIndex={-1}
          role="status"
          className="rounded-xl border border-[var(--accent)]/25 bg-[var(--accent)]/5 p-4 text-sm text-[var(--accent)]"
        >
          {receipt.order.symbol} close confirmed · {receipt.trade.side}{' '}
          {receipt.trade.quantity} at{' '}
          {formatCurrency(receipt.trade.price, 'USD')}. Your current portfolio
          has been refreshed.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-xl border border-amber-300/25 bg-amber-300/5 p-4 text-sm text-amber-200"
        >
          {error}
        </p>
      )}
      {review ? (
        <section
          aria-labelledby="close-position-heading"
          className="rounded-xl border border-rose-300/25 bg-rose-300/5 p-4 sm:p-5"
        >
          <p className="eyebrow text-rose-300">REDUCE ONLY · VIRTUAL FUNDS</p>
          <h3
            id="close-position-heading"
            className="mt-2 text-lg font-semibold"
          >
            Close your {reviewed?.symbol} position?
          </h3>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            {side === 'BUY' ? 'Buy back' : 'Sell'} the full {quantity}{' '}
            {reviewed?.symbol.split('-')[0]} position at market. This action
            cannot open or reverse a position.
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-4 rounded-lg bg-[#101318] p-4 text-sm">
            <div>
              <dt className="text-xs text-[var(--muted)]">
                Current {side === 'BUY' ? 'ask' : 'bid'}
              </dt>
              <dd className="mt-1 font-mono">{formatCurrency(quote, 'USD')}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--muted)]">
                Estimated realized P/L
              </dt>
              <dd className="mt-1 font-mono">
                {formatSignedCurrency(estimatedPnl, 'USD')}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs leading-5 text-[var(--muted)]">
            This is an estimate, not a guaranteed fill. The server uses a fresh
            executable quote. Stop-loss and take-profit orders will be
            cancelled.{' '}
            {pendingEntries > 0
              ? `${pendingEntries} pending entry order${pendingEntries === 1 ? '' : 's'} will remain active and may reopen exposure.`
              : 'Pending entry orders, if added elsewhere, remain active.'}
          </p>
          {changed && !uncertain && (
            <p role="status" className="mt-3 text-sm text-amber-200">
              The position changed during review. Review its current size before
              closing.
            </p>
          )}
          {ticker.status !== 'LIVE' && !uncertain && (
            <p role="status" className="mt-3 text-sm text-amber-200">
              Closing is paused until live quotes return.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              className="button border border-rose-300/30 bg-rose-300/10 text-rose-200 hover:bg-rose-300/20"
              disabled={
                busy ||
                blocked ||
                (!uncertain && (changed || ticker.status !== 'LIVE'))
              }
              onClick={() => void confirm()}
            >
              {busy
                ? 'Closing position…'
                : uncertain
                  ? 'Retry close request'
                  : 'Confirm close position'}
            </button>
            {!uncertain && (
              <button
                type="button"
                ref={cancelButton}
                className="button button-secondary"
                disabled={busy}
                onClick={() => {
                  setReview(null);
                  setError(null);
                  requestAnimationFrame(() => openButton.current?.focus());
                }}
              >
                Keep position
              </button>
            )}
            {changed && !uncertain && position && (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || blocked}
                onClick={beginReview}
              >
                Review current position
              </button>
            )}
          </div>
        </section>
      ) : position ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-4">
          <div>
            <p className="text-sm font-medium">Ready to exit this trade?</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Review a full, reduce-only market close. No quantity entry needed.
            </p>
          </div>
          <button
            ref={openButton}
            type="button"
            className="button button-secondary"
            disabled={blocked || ticker.status !== 'LIVE' || busy}
            onClick={beginReview}
          >
            Close position
          </button>
        </div>
      ) : null}
    </div>
  );
}
