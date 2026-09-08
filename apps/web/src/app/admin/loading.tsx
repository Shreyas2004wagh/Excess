export default function AdminLoading() {
  return (
    <main className="mx-auto min-h-screen max-w-7xl animate-pulse px-6 py-8 sm:px-10">
      <div className="h-14 border-b border-[var(--border)]" />
      <div className="mt-10 h-10 w-80 rounded-xl bg-[var(--surface)]" />
      <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            className="h-28 rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
            key={index}
          />
        ))}
      </div>
    </main>
  );
}
