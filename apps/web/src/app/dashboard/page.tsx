import { UserButton } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  bootstrapSession,
  ExcessApiError,
  getLedger,
  getNotifications,
} from '../../lib/excess-api';
import { formatCurrency, formatDate } from '../../lib/format';
import { NotificationCenter } from '../notifications/notification-center';

export default async function DashboardPage() {
  const session = await auth();
  if (!session.userId) {
    redirect('/sign-in');
  }

  const token = await session.getToken();
  if (!token) {
    redirect('/sign-in');
  }

  try {
    const bootstrap = await bootstrapSession(token);
    const [ledger, notifications] = await Promise.all([
      getLedger(token),
      getNotifications(token),
    ]);
    const { user, account } = bootstrap;

    return (
      <main className="mx-auto min-h-screen max-w-6xl px-6 py-8 sm:px-10">
        <nav className="flex items-center justify-between border-b border-[var(--border)] pb-6">
          <Link
            className="font-mono text-lg font-semibold tracking-[0.18em]"
            href="/"
          >
            EXCESS
          </Link>
          <div className="flex items-center gap-3">
            <Link className="button button-secondary" href="/notifications">
              Notifications
            </Link>
            {user.role === 'ADMIN' ? (
              <Link className="button button-secondary" href="/admin">
                Admin
              </Link>
            ) : null}
            <span className="hidden text-sm text-[var(--muted)] sm:inline">
              {user.email}
            </span>
            <UserButton />
          </div>
        </nav>

        <section className="py-12">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-[var(--accent)]">
            Account dashboard
          </p>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">
                Welcome{user.displayName ? `, ${user.displayName}` : ''}
              </h1>
              <p className="mt-2 text-[var(--muted)]">
                Your paper-trading account is ready.
              </p>
            </div>
            <div className="flex gap-2">
              <span className="rounded-full border border-[var(--border)] px-3 py-1 font-mono text-xs">
                DEMO
              </span>
              <span className="rounded-full bg-[rgb(157_255_91_/_12%)] px-3 py-1 font-mono text-xs text-[var(--accent)]">
                {account.status}
              </span>
            </div>
          </div>

          <div className="mt-10 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <article className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-7 sm:p-9">
              <p className="text-sm text-[var(--muted)]">Virtual balance</p>
              <p className="mt-3 text-5xl font-semibold tracking-[-0.04em] sm:text-6xl">
                {formatCurrency(account.balance, account.baseCurrency)}
              </p>
              <div className="mt-10 flex flex-wrap gap-x-10 gap-y-4 border-t border-[var(--border)] pt-6 text-sm">
                <div>
                  <p className="text-[var(--muted)]">Base currency</p>
                  <p className="mt-1 font-mono">{account.baseCurrency}</p>
                </div>
                <div>
                  <p className="text-[var(--muted)]">Opened</p>
                  <p className="mt-1">{formatDate(account.createdAt)}</p>
                </div>
              </div>
            </article>

            <article className="rounded-3xl border border-[var(--border)] bg-[linear-gradient(145deg,#151d13,#10151d)] p-7 sm:p-9">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--accent)]">
                Market data
              </p>
              <h2 className="mt-5 text-2xl font-semibold">
                BTC and ETH markets are live.
              </h2>
              <p className="mt-3 leading-7 text-[var(--muted)]">
                Follow Coinbase prices and five-minute candles, place simulated
                orders, and monitor margin in real time.
              </p>
              <Link className="button button-primary mt-7" href="/terminal">
                Open terminal
              </Link>
            </article>
          </div>

          <article className="mt-4 rounded-3xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="border-b border-[var(--border)] px-7 py-5">
              <h2 className="font-semibold">Account ledger</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Immutable balance activity for this demo account.
              </p>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {ledger.items.map((entry) => (
                <div
                  className="flex items-center justify-between gap-4 px-7 py-5"
                  key={entry.id}
                >
                  <div>
                    <p className="font-medium">Opening demo credit</p>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {formatDate(entry.createdAt)} · Balance{' '}
                      {formatCurrency(entry.balanceAfter, account.baseCurrency)}
                    </p>
                  </div>
                  <p className="font-mono text-[var(--accent)]">
                    +{formatCurrency(entry.amount, account.baseCurrency)}
                  </p>
                </div>
              ))}
            </div>
          </article>

          <div className="mt-4">
            <NotificationCenter initialNotifications={notifications} />
          </div>
        </section>
      </main>
    );
  } catch (error) {
    if (error instanceof ExcessApiError && error.status === 401) {
      redirect('/sign-in');
    }
    if (error instanceof ExcessApiError && error.status === 403) {
      return (
        <main className="mx-auto flex min-h-screen max-w-xl items-center px-6">
          <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-amber-300">
              Account suspended
            </p>
            <h1 className="mt-4 text-3xl font-semibold">
              This account is unavailable.
            </h1>
            <p className="mt-3 leading-7 text-[var(--muted)]">
              Your trading records have been retained. Contact support if you
              believe this is an error.
            </p>
          </div>
        </main>
      );
    }
    throw error;
  }
}
