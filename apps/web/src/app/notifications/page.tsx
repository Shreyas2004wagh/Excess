import { UserButton } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  bootstrapSession,
  ExcessApiError,
  getNotifications,
} from '../../lib/excess-api';
import { NotificationCenter } from './notification-center';

export default async function NotificationsPage() {
  const session = await auth();
  if (!session.userId) redirect('/sign-in');
  const token = await session.getToken();
  if (!token) redirect('/sign-in');

  try {
    await bootstrapSession(token);
    const notifications = await getNotifications(token);
    return (
      <main className="mx-auto min-h-screen max-w-5xl px-6 py-8 sm:px-10">
        <nav className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border)] pb-6">
          <Link
            className="font-mono text-lg font-semibold tracking-[0.18em]"
            href="/"
          >
            EXCESS
          </Link>
          <div className="flex items-center gap-3">
            <Link className="button button-secondary" href="/dashboard">
              Dashboard
            </Link>
            <Link className="button button-primary" href="/terminal">
              Terminal
            </Link>
            <UserButton />
          </div>
        </nav>
        <header className="py-10">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-[var(--accent)]">
            Delivery center
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">
            Market notifications
          </h1>
          <p className="mt-3 text-[var(--muted)]">
            Durable in-app delivery for your triggered price alerts.
          </p>
        </header>
        <NotificationCenter initialNotifications={notifications} />
      </main>
    );
  } catch (error) {
    if (error instanceof ExcessApiError && error.status === 401) {
      redirect('/sign-in');
    }
    throw error;
  }
}
