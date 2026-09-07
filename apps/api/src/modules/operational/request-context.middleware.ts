import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestContextMiddleware(
  request: Request & { requestId?: string },
  response: Response,
  next: NextFunction,
) {
  const suppliedRequestId = request.get('x-request-id');
  const requestId =
    suppliedRequestId && SAFE_REQUEST_ID.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();

  request.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  if (process.env.NODE_ENV === 'production') {
    response.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }

  next();
}
