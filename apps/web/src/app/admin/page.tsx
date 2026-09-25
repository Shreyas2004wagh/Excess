import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  bootstrapSession,
  ExcessApiError,
  getAdminOverview,
} from '../../lib/excess-api';
import { WorkspaceShell } from '../../components/workspace-shell';
import { AdminConsole } from './admin-console';

function AccessDenied() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-6">
      <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-amber-300">
          Administrator access required
        </p>
        <h1 className="mt-4 text-3xl font-semibold">
          This area is restricted.
        </h1>
        <p className="mt-3 leading-7 text-[var(--muted)]">
          Your signed-in account does not have the administrator role.
        </p>
        <Link className="button button-secondary mt-6" href="/dashboard">
          Return to dashboard
        </Link>
      </div>
    </main>
  );
}

export default async function AdminPage() {
  const session = await auth();
  if (!session.userId) redirect('/sign-in');
  const token = await session.getToken();
  if (!token) redirect('/sign-in');

  try {
    const bootstrap = await bootstrapSession(token);
    if (bootstrap.user.role !== 'ADMIN') return <AccessDenied />;
    const overview = await getAdminOverview(token);
    return (
      <WorkspaceShell active="admin" admin>
        <header className="page-heading">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-[var(--accent)]">
              Operations
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight">
              Administration console
            </h1>
            <p className="mt-3 text-[var(--muted)]">
              Account activity and the alert-delivery pipeline in one view.
            </p>
          </div>
        </header>
        <AdminConsole initialOverview={overview} />
      </WorkspaceShell>
    );
  } catch (error) {
    if (error instanceof ExcessApiError && error.status === 401) {
      redirect('/sign-in');
    }
    if (error instanceof ExcessApiError && error.status === 403) {
      return <AccessDenied />;
    }
    throw error;
  }
}
