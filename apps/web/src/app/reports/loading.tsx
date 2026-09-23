export default function ReportsLoading() {
  return (
    <main
      className="mx-auto min-h-screen max-w-7xl px-6 py-12"
      aria-busy="true"
    >
      <p role="status">Loading your trading report…</p>
      <div className="mt-8 h-64 animate-pulse rounded-2xl bg-[var(--surface)]" />
    </main>
  );
}
