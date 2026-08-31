export default function DashboardLoading() {
  return (
    <main className="mx-auto min-h-screen max-w-6xl animate-pulse px-6 py-8 sm:px-10">
      <div className="h-12 border-b border-[var(--border)]" />
      <div className="mt-12 h-10 w-72 rounded-xl bg-[var(--surface)]" />
      <div className="mt-10 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="h-72 rounded-3xl bg-[var(--surface)]" />
        <div className="h-72 rounded-3xl bg-[var(--surface)]" />
      </div>
    </main>
  );
}
