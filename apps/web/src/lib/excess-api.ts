import type {
  LedgerPage,
  SessionBootstrapResponse,
} from '@excess/shared-types';

export class ExcessApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExcessApiError';
  }
}

const apiBaseUrl =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:4000/api/v1';

async function request<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      message?: string | { code?: string; message?: string };
    } | null;
    const nestedMessage =
      typeof payload?.message === 'object' ? payload.message : null;
    throw new ExcessApiError(
      response.status,
      payload?.code ?? nestedMessage?.code ?? 'EXCESS_API_ERROR',
      (typeof payload?.message === 'string' ? payload.message : undefined) ??
        nestedMessage?.message ??
        'The Excess API request failed',
    );
  }

  return response.json() as Promise<T>;
}

export function bootstrapSession(token: string) {
  return request<SessionBootstrapResponse>('/session/bootstrap', token, {
    method: 'POST',
  });
}

export function getLedger(token: string) {
  return request<LedgerPage>('/accounts/demo/ledger?limit=20', token);
}
