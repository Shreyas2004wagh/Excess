import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { MetricsService, normalizeHttpMethod } from './metrics.service.js';

export type ObservableRequest = Request & {
  requestId?: string;
  internalHttpError?: boolean;
};

interface HttpLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function safeRouteTemplate(request: Request): string {
  const route: unknown = request.route?.path;
  // Only a server-registered template is safe. Never fall back to originalUrl,
  // path, query, user/session IDs, raw headers, or a body supplied by a client.
  return typeof route === 'string' &&
    route.length <= 180 &&
    /^\/[A-Za-z0-9_/:.*{}()-]*$/.test(route)
    ? route
    : 'unmatched';
}

export function requestObservabilityMiddleware(
  metrics: MetricsService,
  logger: HttpLogger = new Logger('HTTP'),
  now = () => performance.now(),
) {
  return (
    request: ObservableRequest,
    response: Response,
    next: NextFunction,
  ) => {
    const startedAt = now();
    let recorded = false;
    const record = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;
      const statusCode = request.internalHttpError
        ? 500
        : aborted
          ? 499
          : response.statusCode;
      const method = normalizeHttpMethod(request.method);
      const durationMs = Math.max(0, now() - startedAt);
      metrics.observeHttpRequest(method, statusCode, durationMs);
      const entry = JSON.stringify({
        event:
          statusCode >= 500
            ? 'http.request.failed'
            : aborted
              ? 'http.request.aborted'
              : 'http.request.completed',
        requestId:
          request.requestId && /^[A-Za-z0-9._-]{1,128}$/.test(request.requestId)
            ? request.requestId
            : undefined,
        method,
        route: safeRouteTemplate(request),
        statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
      if (statusCode >= 500) logger.error(entry);
      else if (statusCode >= 400) logger.warn(entry);
      else logger.log(entry);
    };
    response.once('finish', () => record(false));
    response.once('close', () => record(!response.writableFinished));
    next();
  };
}
