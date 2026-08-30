const foundations = [
  'Modular NestJS API',
  'PostgreSQL + Prisma',
  'Redis-backed realtime',
  'Next.js trading terminal',
];

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-6 py-16">
      <p className="mb-5 font-mono text-sm uppercase tracking-[0.28em] text-[var(--accent)]">
        Excess / Foundation
      </p>
      <h1 className="max-w-4xl text-5xl font-semibold tracking-[-0.045em] sm:text-7xl">
        Paper trading, built around a trustworthy financial core.
      </h1>
      <p className="mt-7 max-w-2xl text-lg leading-8 text-[var(--muted)]">
        The first milestone is one complete flow: receive $10,000, watch
        BTC-USD, place a market order, and see profit and loss update live.
      </p>

      <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {foundations.map((foundation, index) => (
          <div
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
            key={foundation}
          >
            <span className="font-mono text-xs text-[var(--accent)]">
              0{index + 1}
            </span>
            <p className="mt-7 text-sm text-[var(--foreground)]">
              {foundation}
            </p>
          </div>
        ))}
      </div>
    </main>
  );
}
