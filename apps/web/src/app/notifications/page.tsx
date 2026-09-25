import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

import {
  bootstrapSession,
  ExcessApiError,
  getNotifications,
} from '../../lib/excess-api';
import { WorkspaceShell } from '../../components/workspace-shell';
import { NotificationCenter } from './notification-center';

export default async function NotificationsPage() {
  const session = await auth();
  if (!session.userId) redirect('/sign-in');
  const token = await session.getToken();
  if (!token) redirect('/sign-in');

  try {
    const bootstrap = await bootstrapSession(token);
    const notifications = await getNotifications(token);
    return (
      <WorkspaceShell
        active="notifications"
        admin={bootstrap.user.role === 'ADMIN'}
      >
        <header className="page-heading">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-[var(--accent)]">
              Delivery center
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight">
              Market notifications
            </h1>
            <p className="mt-3 text-[var(--muted)]">
              Your setups, followed through. Keep track of triggered price
              alerts.
            </p>
          </div>
        </header>
        <NotificationCenter initialNotifications={notifications} />
      </WorkspaceShell>
    );
  } catch (error) {
    if (error instanceof ExcessApiError && error.status === 401) {
      redirect('/sign-in');
    }
    throw error;
  }
}
