export default function TerminalLoading() {
  return (
    <main className="min-h-screen animate-pulse px-4 py-4 sm:px-6">
      <div className="h-14 rounded-2xl bg-[var(--surface)]" />
      <div className="mt-4 grid gap-4 lg:grid-cols-[220px_1fr_300px]">
        <div className="h-[720px] rounded-2xl bg-[var(--surface)]" />
        <div className="h-[720px] rounded-2xl bg-[var(--surface)]" />
        <div className="h-[720px] rounded-2xl bg-[var(--surface)]" />
      </div>
    </main>
  );
}
