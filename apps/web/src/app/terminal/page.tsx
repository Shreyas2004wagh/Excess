import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

import {
  bootstrapSession,
  ExcessApiError,
  getMarketCandles,
  getMarketInstrument,
} from '../../lib/excess-api';
import { MarketTerminal } from './market-terminal';

export default async function TerminalPage() {
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
    const [instrument, candles] = await Promise.all([
      getMarketInstrument(token),
      getMarketCandles(token),
    ]);

    return (
      <MarketTerminal
        account={bootstrap.account}
        candles={candles}
        instrument={instrument}
        user={bootstrap.user}
      />
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
              Market access is unavailable.
            </h1>
            <p className="mt-3 leading-7 text-[var(--muted)]">
              Your account records remain intact. Contact support if you believe
              this is an error.
            </p>
          </div>
        </main>
      );
    }
    throw error;
  }
}
