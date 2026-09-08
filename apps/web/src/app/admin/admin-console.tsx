'use client';

import { useAuth } from '@clerk/nextjs';
import type { AdminOverviewResponse } from '@excess/shared-types';
import { useEffect, useState } from 'react';

import { getAdminOverview, retryAdminDelivery } from '../../lib/excess-api';
import { formatDate } from '../../lib/format';

function deliveryTone(status: string) {
  if (status === 'PUBLISHED') return 'text-[var(--accent)]';
  if (status === 'FAILED') return 'text-rose-300';
  if (status === 'PROCESSING') return 'text-sky-300';
  return 'text-amber-300';
}

export function AdminConsole({
  initialOverview,
}: {
  initialOverview: AdminOverviewResponse;
}) {
  const { getToken } = useAuth();
  const [overview, setOverview] = useState(initialOverview);
  const [error, setError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const token = await getToken();
        if (!token) return;
        const nextOverview = await getAdminOverview(token);
        if (active) {
          setOverview(nextOverview);
          setError(null);
        }
      } catch {
        if (active) setError('Live administration metrics are unavailable.');
      }
    }
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [getToken]);

  async function retryDelivery(eventId: string) {
    setRetryingId(eventId);
    try {
      const token = await getToken();
      if (!token) return;
      await retryAdminDelivery(token, eventId);
      setOverview(await getAdminOverview(token));
      setError(null);
    } catch {
      setError('The failed delivery could not be queued for retry.');
    } finally {
      setRetryingId(null);
    }
  }

  const metricCards = [
    ['Users', overview.totals.users],
    ['Active users', overview.totals.activeUsers],
    ['Demo accounts', overview.totals.demoAccounts],
    ['Open orders', overview.totals.openOrders],
    ['Open positions', overview.totals.openPositions],
    ['Active alerts', overview.totals.activePriceAlerts],
    ['Unread notices', overview.totals.unreadNotifications],
  ] as const;

  return (
    <div className="space-y-4" data-testid="admin-console">
      {error ? (
        <p
          className="rounded-2xl border border-amber-300/20 bg-amber-300/5 px-5 py-3 text-sm text-amber-200"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {metricCards.map(([label, value]) => (
          <article
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
            key={label}
          >
            <p className="text-sm text-[var(--muted)]">{label}</p>
            <p className="mt-2 font-mono text-3xl font-semibold">{value}</p>
          </article>
        ))}
      </section>

      <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
        <div>
          <p className="font-medium">System readiness</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Database {overview.system.checks.database} · Redis{' '}
            {overview.system.checks.redis} · Market data{' '}
            {overview.system.checks.marketData}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 font-mono text-xs ${
            overview.system.status === 'ready'
              ? 'bg-[rgb(157_255_91_/_12%)] text-[var(--accent)]'
              : 'bg-rose-300/10 text-rose-200'
          }`}
        >
          {overview.system.status.toUpperCase()}
        </span>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <article className="overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)]">
          <header className="border-b border-[var(--border)] px-6 py-5">
            <h2 className="font-semibold">Alert delivery pipeline</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Pending {overview.deliveries.pending} · Processing{' '}
              {overview.deliveries.processing} · Published{' '}
              {overview.deliveries.published} · Failed{' '}
              {overview.deliveries.failed}
            </p>
          </header>
          <div className="divide-y divide-[var(--border)]">
            {overview.recentDeliveries.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-[var(--muted)]">
                No alert deliveries have been recorded.
              </p>
            ) : (
              overview.recentDeliveries.map((delivery) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-4 px-6 py-4"
                  key={delivery.id}
                >
                  <div>
                    <p className="font-medium">{delivery.eventType}</p>
                    <p className="mt-1 font-mono text-xs text-[var(--muted)]">
                      {delivery.aggregateId} · {formatDate(delivery.createdAt)}
                    </p>
                    {delivery.lastError ? (
                      <p className="mt-2 max-w-xl text-sm text-rose-200">
                        {delivery.lastError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`font-mono text-xs ${deliveryTone(delivery.status)}`}
                    >
                      {delivery.status} · {delivery.attempts} attempt
                      {delivery.attempts === 1 ? '' : 's'}
                    </span>
                    {delivery.status === 'FAILED' ? (
                      <button
                        className="button button-secondary"
                        disabled={retryingId === delivery.id}
                        onClick={() => void retryDelivery(delivery.id)}
                        type="button"
                      >
                        {retryingId === delivery.id ? 'Queuing…' : 'Retry'}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </article>

        <article className="overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)]">
          <header className="border-b border-[var(--border)] px-6 py-5">
            <h2 className="font-semibold">Recent users</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Identity and account access state.
            </p>
          </header>
          <div className="divide-y divide-[var(--border)]">
            {overview.recentUsers.map((user) => (
              <div className="px-6 py-4" key={user.id}>
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate font-medium">
                    {user.displayName ?? user.email}
                  </p>
                  <span className="font-mono text-[10px] text-[var(--accent)]">
                    {user.role}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-[var(--muted)]">
                  {user.email}
                </p>
                <p className="mt-2 font-mono text-xs text-[var(--muted)]">
                  {user.status} · {formatDate(user.createdAt)}
                </p>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)]">
        <header className="border-b border-[var(--border)] px-6 py-5">
          <h2 className="font-semibold">Recent audit activity</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Security, trading, risk, and delivery events retained by the API.
          </p>
        </header>
        <div className="divide-y divide-[var(--border)]">
          {overview.recentAuditEvents.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-[var(--muted)]">
              No audit activity has been recorded.
            </p>
          ) : (
            overview.recentAuditEvents.map((event) => (
              <div
                className="grid gap-2 px-6 py-4 text-sm sm:grid-cols-[1.2fr_1fr_auto] sm:items-center"
                key={event.id}
              >
                <div>
                  <p className="font-medium">{event.action}</p>
                  <p className="mt-1 text-[var(--muted)]">
                    {event.actorEmail ?? 'System'}
                  </p>
                </div>
                <p className="font-mono text-xs text-[var(--muted)]">
                  {event.resourceType}
                  {event.resourceId ? ` · ${event.resourceId}` : ''}
                </p>
                <p className="font-mono text-xs text-[var(--muted)]">
                  {formatDate(event.createdAt)}
                </p>
              </div>
            ))
          )}
        </div>
      </section>

      <p className="text-right font-mono text-xs text-[var(--muted)]">
        Updated {formatDate(overview.generatedAt)}
      </p>
    </div>
  );
}
