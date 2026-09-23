import { UserButton } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import {
  MARKET_SYMBOLS,
  type MarketSymbol,
  type TradingReportQuery,
} from '@excess/shared-types';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  bootstrapSession,
  ExcessApiError,
  getTradingReport,
} from '../../lib/excess-api';
import { TradingReports } from './trading-reports';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session.userId) redirect('/sign-in');
  const token = await session.getToken();
  if (!token) redirect('/sign-in');

  try {
    const params = await searchParams;
    const query: TradingReportQuery = {};
    for (const field of ['from', 'to', 'symbol'] as const) {
      const value = params[field];
      if (
        Array.isArray(value) ||
        (field === 'symbol' &&
          value &&
          !MARKET_SYMBOLS.includes(value as MarketSymbol))
      ) {
        throw new ExcessApiError(
          400,
          'INVALID_REPORT_QUERY',
          'Choose one supported instrument and one value per date.',
        );
      }
      if (value) {
        if (field === 'symbol') query.symbol = value as MarketSymbol;
        else query[field] = value;
      }
    }
    await bootstrapSession(token);
    const report = await getTradingReport(token, query);
    return (
      <main className="mx-auto min-h-screen max-w-7xl px-4 py-8 sm:px-8">
        <nav
          aria-label="Main navigation"
          className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border)] pb-6"
        >
          <Link
            className="font-mono text-lg font-semibold tracking-[0.18em]"
            href="/"
          >
            EXCESS
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <Link className="button button-secondary" href="/dashboard">
              Dashboard
            </Link>
            <Link className="button button-secondary" href="/terminal">
              Terminal
            </Link>
            <UserButton />
          </div>
        </nav>
        <TradingReports key={report.filters.asOf} initialReport={report} />
      </main>
    );
  } catch (error) {
    if (error instanceof ExcessApiError && error.status === 401)
      redirect('/sign-in');
    if (error instanceof ExcessApiError && [400, 403].includes(error.status)) {
      return (
        <main className="mx-auto max-w-xl px-6 py-20">
          <h1 className="text-3xl font-semibold">
            {error.status === 403
              ? 'Account suspended'
              : 'Check your report filters'}
          </h1>
          <p className="mt-4 text-[var(--muted)]">{error.message}</p>
          <Link
            className="button button-secondary mt-6"
            href={error.status === 403 ? '/dashboard' : '/reports'}
          >
            {error.status === 403 ? 'Back to dashboard' : 'Reset filters'}
          </Link>
        </main>
      );
    }
    throw error;
  }
}
