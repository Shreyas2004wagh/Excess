'use client';

export default function ReportsError({ retry }: { retry: () => void }) {
  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <h1 className="text-3xl font-semibold">
        Your report could not be loaded.
      </h1>
      <p className="mt-4 text-[var(--muted)]">
        Your trades and account records are unchanged. Retry the connection.
      </p>
      <button
        className="button button-primary mt-6"
        onClick={retry}
        type="button"
      >
        Try again
      </button>
    </main>
  );
}
