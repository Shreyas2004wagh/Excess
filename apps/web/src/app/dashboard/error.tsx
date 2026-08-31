'use client';

export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-6">
      <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-rose-300">
          Provisioning interrupted
        </p>
        <h1 className="mt-4 text-3xl font-semibold">
          We could not load your account.
        </h1>
        <p className="mt-3 leading-7 text-[var(--muted)]">
          Your balance is safe. Retry the connection to finish loading the
          dashboard.
        </p>
        <button
          className="button button-primary mt-7"
          onClick={reset}
          type="button"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
