'use client';

import { useAuth } from '@clerk/nextjs';
import type { NotificationsResponse } from '@excess/shared-types';
import { useEffect, useState } from 'react';

import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../lib/excess-api';
import { formatDate } from '../../lib/format';

export function NotificationCenter({
  initialNotifications,
}: {
  initialNotifications: NotificationsResponse;
}) {
  const { getToken } = useAuth();
  const [notifications, setNotifications] = useState(initialNotifications);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const token = await getToken();
        if (!token) return;
        const latest = await getNotifications(token);
        if (active) {
          setNotifications(latest);
          setError(null);
        }
      } catch {
        if (active) setError('Live notification updates are unavailable.');
      }
    }

    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [getToken]);

  async function markRead(notificationId: string) {
    setUpdating(true);
    try {
      const token = await getToken();
      if (!token) return;
      const updated = await markNotificationRead(token, notificationId);
      setNotifications((current) => ({
        items: current.items.map((item) =>
          item.id === updated.id ? updated : item,
        ),
        unreadCount: Math.max(
          0,
          current.unreadCount -
            (current.items.find((item) => item.id === updated.id)?.readAt
              ? 0
              : 1),
        ),
      }));
      setError(null);
    } catch {
      setError('The notification could not be updated.');
    } finally {
      setUpdating(false);
    }
  }

  async function markAllRead() {
    setUpdating(true);
    try {
      const token = await getToken();
      if (!token) return;
      setNotifications(await markAllNotificationsRead(token));
      setError(null);
    } catch {
      setError('Notifications could not be updated.');
    } finally {
      setUpdating(false);
    }
  }

  return (
    <section
      className="rounded-3xl border border-[var(--border)] bg-[var(--surface)]"
      data-testid="notification-center"
    >
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border)] px-7 py-5">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="font-semibold">Notifications</h2>
            {notifications.unreadCount > 0 ? (
              <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-mono text-xs text-[#0b1008]">
                {notifications.unreadCount} unread
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Alert deliveries update automatically.
          </p>
        </div>
        {notifications.unreadCount > 0 ? (
          <button
            className="button button-secondary"
            disabled={updating}
            onClick={() => void markAllRead()}
            type="button"
          >
            Mark all read
          </button>
        ) : null}
      </header>

      {error ? (
        <p
          className="border-b border-amber-300/20 bg-amber-300/5 px-7 py-3 text-sm text-amber-200"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="divide-y divide-[var(--border)]">
        {notifications.items.length === 0 ? (
          <div className="px-7 py-10 text-center text-sm text-[var(--muted)]">
            No notifications yet. Triggered price alerts will appear here.
          </div>
        ) : (
          notifications.items.map((notification) => (
            <article
              className={`px-7 py-5 ${notification.readAt ? '' : 'bg-[rgb(157_255_91_/_4%)]'}`}
              key={notification.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-3xl">
                  <div className="flex items-center gap-2">
                    {!notification.readAt ? (
                      <span
                        aria-label="Unread"
                        className="h-2 w-2 rounded-full bg-[var(--accent)]"
                      />
                    ) : null}
                    <h3 className="font-medium">{notification.title}</h3>
                  </div>
                  <p className="mt-2 leading-6 text-[var(--muted)]">
                    {notification.message}
                  </p>
                  <p className="mt-2 font-mono text-xs text-[var(--muted)]">
                    {formatDate(notification.createdAt)}
                  </p>
                </div>
                {!notification.readAt ? (
                  <button
                    className="button button-secondary"
                    disabled={updating}
                    onClick={() => void markRead(notification.id)}
                    type="button"
                  >
                    Mark read
                  </button>
                ) : (
                  <span className="font-mono text-xs text-[var(--muted)]">
                    Read
                  </span>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
