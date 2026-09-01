'use client';

import Link from 'next/link';

export default function TerminalError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-6">
      <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-rose-300">
          Market feed interrupted
        </p>
        <h1 className="mt-4 text-3xl font-semibold">
          The BTC-USD terminal could not load.
        </h1>
        <p className="mt-3 leading-7 text-[var(--muted)]">
          Your account is unaffected. Retry the feed or return to your account
          dashboard.
        </p>
        <div className="mt-7 flex gap-3">
          <button
            className="button button-primary"
            onClick={reset}
            type="button"
          >
            Retry feed
          </button>
          <Link className="button button-secondary" href="/dashboard">
            Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
