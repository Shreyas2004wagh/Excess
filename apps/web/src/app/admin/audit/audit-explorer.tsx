'use client';

import { useAuth } from '@clerk/nextjs';
import type { AdminAuditPage, AdminAuditQuery } from '@excess/shared-types';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { Icon } from '../../../components/icon';
import { ExcessApiError, getAdminAuditEvents } from '../../../lib/excess-api';

const inputClass =
  'mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm';
const optionalFields = [
  'action',
  'actorUserId',
  'resourceType',
  'resourceId',
] as const;
const actions = [
  'ORDER_ACCEPTED',
  'ORDER_FILLED',
  'ORDER_CANCELLED',
  'NEGATIVE_BALANCE_PROTECTED',
  'PRICE_ALERT_TRIGGERED',
  'IN_APP_NOTIFICATION_DELIVERED',
  'ALERT_EMAIL_DELIVERED',
  'OUTBOX_DELIVERY_RETRIED',
];

function emptyFilters() {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    action: '',
    actorUserId: '',
    resourceType: '',
    resourceId: '',
  };
}

export function AuditExplorer({
  initialPage,
  initialError,
}: {
  initialPage?: AdminAuditPage;
  initialError?: string;
}) {
  const { getToken } = useAuth();
  const [page, setPage] = useState(initialPage);
  const [draft, setDraft] = useState(() =>
    initialPage
      ? {
          from: initialPage.filters.from,
          to: initialPage.filters.to,
          action: initialPage.filters.action ?? '',
          actorUserId: initialPage.filters.actorUserId ?? '',
          resourceType: initialPage.filters.resourceType ?? '',
          resourceId: initialPage.filters.resourceId ?? '',
        }
      : emptyFilters(),
  );
  const [busy, setBusy] = useState<'filter' | 'more' | null>(null);
  const [error, setError] = useState(initialError ?? null);
  const [blocked, setBlocked] = useState(false);
  const pending = useRef(false);

  function appliedQuery(): AdminAuditQuery {
    if (!page) return {};
    const query: AdminAuditQuery = {
      from: page.filters.from,
      to: page.filters.to,
      asOf: page.filters.asOf,
    };
    for (const field of optionalFields)
      if (page.filters[field]) query[field] = page.filters[field]!;
    return query;
  }

  async function load(query: AdminAuditQuery, more = false) {
    if (pending.current || blocked) return;
    pending.current = true;
    setBusy(more ? 'more' : 'filter');
    setError(null);
    try {
      const token = await getToken();
      if (!token) {
        window.location.assign('/sign-in');
        return;
      }
      const next = await getAdminAuditEvents(token, query);
      setPage((previous) =>
        more && previous
          ? {
              ...next,
              items: [
                ...previous.items,
                ...next.items.filter(
                  (item) => !previous.items.some((old) => old.id === item.id),
                ),
              ],
            }
          : next,
      );
      if (!more) {
        const params = new URLSearchParams({
          from: next.filters.from,
          to: next.filters.to,
        });
        for (const field of optionalFields)
          if (next.filters[field]) params.set(field, next.filters[field]!);
        window.history.replaceState(null, '', `/admin/audit?${params}`);
      }
    } catch (cause) {
      if (cause instanceof ExcessApiError && cause.status === 401) {
        window.location.assign('/sign-in');
        return;
      }
      if (cause instanceof ExcessApiError && cause.status === 403) {
        setBlocked(true);
        setPage(undefined);
      }
      setError(
        cause instanceof ExcessApiError
          ? cause.message
          : 'Audit activity could not be loaded. Try again.',
      );
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query: AdminAuditQuery = { from: draft.from, to: draft.to };
    for (const field of optionalFields)
      if (draft[field].trim()) query[field] = draft[field].trim();
    void load(query);
  }

  return (
    <section>
      <header className="page-heading">
        <div>
          <p className="eyebrow">OPERATIONS / AUDIT</p>
          <h1>Audit explorer</h1>
          <p className="description">
            Trace trading, risk, and delivery activity. All dates and times are
            UTC.
          </p>
        </div>
        <Link className="button button-secondary" href="/admin">
          Back to operations <Icon name="arrow" size={16} />
        </Link>
      </header>
      <form
        className="panel grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3"
        onSubmit={apply}
      >
        {(['from', 'to'] as const).map((field) => (
          <label className="text-sm" key={field}>
            {field === 'from' ? 'From (UTC)' : 'To (UTC)'}
            <input
              className={inputClass}
              type="date"
              required
              value={draft[field]}
              min={field === 'to' ? draft.from : undefined}
              onChange={(event) =>
                setDraft({ ...draft, [field]: event.target.value })
              }
            />
          </label>
        ))}
        <label className="text-sm">
          Action
          <input
            className={`${inputClass} font-mono`}
            list="audit-actions"
            placeholder="All actions"
            maxLength={80}
            value={draft.action}
            onChange={(event) =>
              setDraft({ ...draft, action: event.target.value.toUpperCase() })
            }
          />
        </label>
        <datalist id="audit-actions">
          {actions.map((action) => (
            <option value={action} key={action} />
          ))}
        </datalist>
        <label className="text-sm">
          Associated user ID
          <input
            className={`${inputClass} font-mono`}
            placeholder="Any user · UUID"
            value={draft.actorUserId}
            onChange={(event) =>
              setDraft({ ...draft, actorUserId: event.target.value })
            }
          />
        </label>
        <label className="text-sm">
          Resource type
          <input
            className={`${inputClass} font-mono`}
            placeholder="Any resource · e.g. ORDER"
            maxLength={80}
            value={draft.resourceType}
            onChange={(event) =>
              setDraft({
                ...draft,
                resourceType: event.target.value.toUpperCase(),
              })
            }
          />
        </label>
        <label className="text-sm">
          Resource ID
          <input
            className={`${inputClass} font-mono`}
            placeholder="Exact resource identifier"
            maxLength={128}
            value={draft.resourceId}
            onChange={(event) =>
              setDraft({ ...draft, resourceId: event.target.value })
            }
          />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 xl:col-span-3">
          <button
            className="button button-primary"
            type="submit"
            disabled={!!busy || blocked}
          >
            {busy === 'filter' ? 'Loading…' : 'Apply filters'}
          </button>
          <button
            className="button button-quiet"
            type="button"
            disabled={!!busy || blocked}
            onClick={() =>
              setDraft({
                ...draft,
                action: '',
                actorUserId: '',
                resourceType: '',
                resourceId: '',
              })
            }
          >
            Clear event filters
          </button>
          <span className="text-xs text-[var(--muted)]">
            Up to 366 days per search.
          </span>
        </div>
      </form>
      {error ? (
        <p
          className="mt-4 rounded-xl border border-rose-300/30 p-4 text-sm text-rose-300"
          role="alert"
        >
          {error}
          {blocked
            ? ' Administrator access is no longer available.'
            : page
              ? ' Previous results are still displayed; retry when ready.'
              : ' Adjust the filters and try again.'}
        </p>
      ) : null}
      {page ? (
        <>
          <div className="my-5 flex flex-wrap items-start justify-between gap-3">
            <div
              className="text-xs leading-6 text-[var(--muted)]"
              data-testid="audit-range"
            >
              <p>
                Showing {page.filters.from} through {page.filters.to} · Newest
                first
              </p>
              <p>
                Applied filters:{' '}
                {optionalFields
                  .filter((field) => page.filters[field])
                  .map((field) => `${field}: ${page.filters[field]}`)
                  .join(' · ') || 'All events'}
              </p>
            </div>
            <button
              className="button button-secondary"
              type="button"
              disabled={!!busy || blocked}
              onClick={() => {
                const query = appliedQuery();
                delete query.asOf;
                void load(query);
              }}
            >
              <Icon name="refresh" size={14} /> Refresh results
            </button>
          </div>
          <div
            className="panel overflow-hidden"
            aria-busy={!!busy}
            data-testid="audit-events"
          >
            <header className="panel-heading">
              <h2>Recorded activity</h2>
              <span className="font-mono text-xs text-[var(--muted)]">
                {page.items.length} loaded
              </span>
            </header>
            {page.items.length ? (
              <div className="divide-y divide-[var(--border)]">
                {page.items.map((event) => (
                  <article
                    className="px-5 py-5"
                    key={event.id}
                    data-testid="audit-event"
                  >
                    <div className="grid gap-3 md:grid-cols-[1.3fr_1fr_auto]">
                      <div>
                        <p className="break-words font-mono text-xs text-[var(--accent)]">
                          {event.action}
                        </p>
                        <p className="mt-2 break-all text-sm">
                          {event.actorEmail ?? 'System / no associated user'}
                        </p>
                      </div>
                      <div className="text-xs text-[var(--muted)]">
                        <p>{event.resourceType}</p>
                        <p className="mt-2 break-all font-mono">
                          {event.resourceId ?? 'No resource identifier'}
                        </p>
                      </div>
                      <time
                        className="font-mono text-xs text-[var(--muted)]"
                        dateTime={event.createdAt}
                      >
                        {event.createdAt.replace('T', ' ').replace('Z', ' UTC')}
                      </time>
                    </div>
                    <details className="mt-4 rounded-xl border border-[var(--border)] p-3 text-xs">
                      <summary className="text-[var(--muted)]">
                        View event details
                      </summary>
                      <dl className="mt-4 grid gap-3 break-all sm:grid-cols-2">
                        <div>
                          <dt className="text-[var(--muted)]">Event ID</dt>
                          <dd className="mt-1 font-mono">{event.id}</dd>
                        </div>
                        <div>
                          <dt className="text-[var(--muted)]">
                            Associated user ID
                          </dt>
                          <dd className="mt-1 font-mono">
                            {event.actorUserId ?? '—'}
                          </dd>
                        </div>
                      </dl>
                      {event.metadata && Object.keys(event.metadata).length ? (
                        <pre
                          className="mt-4 max-h-64 overflow-auto rounded-lg bg-[var(--background)] p-3 font-mono leading-6"
                          aria-label="Event metadata"
                          tabIndex={0}
                        >
                          {JSON.stringify(event.metadata, null, 2)}
                        </pre>
                      ) : (
                        <p className="mt-4 text-[var(--muted)]">
                          No additional event details.
                        </p>
                      )}
                    </details>
                  </article>
                ))}
              </div>
            ) : (
              <div className="px-6 py-14 text-center">
                <Icon name="activity" size={28} />
                <h2 className="mt-4 font-medium">No matching activity.</h2>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Try a wider date range or fewer event filters.
                </p>
              </div>
            )}
            {page.nextCursor ? (
              <div className="border-t border-[var(--border)] p-4">
                <button
                  className="button button-secondary w-full"
                  disabled={!!busy || blocked}
                  type="button"
                  onClick={() =>
                    void load(
                      { ...appliedQuery(), cursor: page.nextCursor! },
                      true,
                    )
                  }
                >
                  {busy === 'more' ? 'Loading…' : 'Load more events'}
                </button>
              </div>
            ) : null}
          </div>
          <p className="mt-4 text-xs leading-6 text-[var(--muted)]">
            Associated users identify the account involved; an automatic fill or
            risk action may retain the account owner. Refresh results to include
            newly recorded activity.
          </p>
        </>
      ) : null}
    </section>
  );
}
