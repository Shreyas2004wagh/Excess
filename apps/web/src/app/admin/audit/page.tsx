import { auth } from '@clerk/nextjs/server';
import type { AdminAuditQuery } from '@excess/shared-types';
import { redirect } from 'next/navigation';
import { PageState } from '../../../components/page-state';
import { WorkspaceShell } from '../../../components/workspace-shell';
import {
  bootstrapSession,
  ExcessApiError,
  getAdminAuditEvents,
} from '../../../lib/excess-api';
import { AuditExplorer } from './audit-explorer';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session.userId) redirect('/sign-in');
  const token = await session.getToken();
  if (!token) redirect('/sign-in');
  try {
    const bootstrap = await bootstrapSession(token);
    if (bootstrap.user.role !== 'ADMIN')
      throw new ExcessApiError(
        403,
        'ADMIN_REQUIRED',
        'Administrator access is required.',
      );
    const params = await searchParams;
    const query: AdminAuditQuery = {};
    for (const field of [
      'from',
      'to',
      'action',
      'actorUserId',
      'resourceType',
      'resourceId',
    ] as const) {
      const value = params[field];
      if (Array.isArray(value))
        throw new ExcessApiError(
          400,
          'INVALID_AUDIT_QUERY',
          'Choose one value per filter.',
        );
      if (value) query[field] = value;
    }
    const events = await getAdminAuditEvents(token, query);
    return (
      <WorkspaceShell active="admin" admin>
        <AuditExplorer key={events.filters.asOf} initialPage={events} />
      </WorkspaceShell>
    );
  } catch (cause) {
    if (cause instanceof ExcessApiError && cause.status === 401)
      redirect('/sign-in');
    if (cause instanceof ExcessApiError && cause.status === 403)
      return (
        <PageState
          warning
          title="Administrator access required."
          message="Your signed-in account cannot access the audit explorer."
        />
      );
    if (cause instanceof ExcessApiError && cause.status === 400) {
      return (
        <WorkspaceShell active="admin" admin>
          <AuditExplorer initialError={cause.message} />
        </WorkspaceShell>
      );
    }
    throw cause;
  }
}
