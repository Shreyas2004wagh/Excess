import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

import { requestContextMiddleware } from './request-context.middleware.js';

function runMiddleware(suppliedRequestId?: string) {
  const headers = new Map<string, string | number>();
  const request = {
    get: jest.fn((name: string) =>
      name === 'x-request-id' ? suppliedRequestId : undefined,
    ),
  } as unknown as Request & { requestId?: string };
  const response = {
    setHeader: jest.fn((name: string, value: string | number) => {
      headers.set(name, value);
    }),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;

  requestContextMiddleware(request, response, next);
  return { headers, next, request };
}

describe('requestContextMiddleware', () => {
  it('preserves safe request IDs and adds defensive response headers', () => {
    const { headers, next, request } = runMiddleware('client-request_123');

    expect(request.requestId).toBe('client-request_123');
    expect(headers.get('X-Request-Id')).toBe('client-request_123');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('replaces unsafe request IDs', () => {
    const { headers, request } = runMiddleware('unsafe request id');

    expect(request.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(headers.get('X-Request-Id')).toBe(request.requestId);
  });
});
