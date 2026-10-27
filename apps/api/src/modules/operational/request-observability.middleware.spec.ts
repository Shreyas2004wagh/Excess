import { EventEmitter } from 'node:events';

import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Response } from 'express';

import { MetricsService } from './metrics.service.js';
import {
  requestObservabilityMiddleware,
  safeRouteTemplate,
  type ObservableRequest,
} from './request-observability.middleware.js';

function fixture(statusCode = 200) {
  const metrics = new MetricsService();
  const observe = jest.spyOn(metrics, 'observeHttpRequest');
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const request = {
    method: 'GET',
    requestId: 'trace-123',
    originalUrl:
      '/api/v1/orders/private-order?token=TOPSECRET&email=person@example.invalid',
    headers: { authorization: 'Bearer TOPSECRET', cookie: 'session=TOPSECRET' },
    body: { password: 'TOPSECRET' },
    identity: { clerkUserId: 'private-user', sessionId: 'private-session' },
    route: { path: '/api/v1/orders/:id' },
  } as unknown as ObservableRequest;
  const response = Object.assign(new EventEmitter(), {
    statusCode,
    writableFinished: false,
  });
  const next = jest.fn();
  let time = 100;
  requestObservabilityMiddleware(metrics, logger, () => time)(
    request,
    response as unknown as Response,
    next as NextFunction,
  );
  time = 145;
  return { metrics, observe, logger, request, response, next };
}

describe('requestObservabilityMiddleware', () => {
  it('logs a registered route, not sensitive paths, query, headers, body or identities', () => {
    const f = fixture();
    f.response.writableFinished = true;
    f.response.emit('finish');
    f.response.emit('close');
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.observe).toHaveBeenCalledWith('GET', 200, 45);
    const output = f.logger.log.mock.calls[0]?.[0] as string;
    expect(JSON.parse(output)).toMatchObject({
      route: '/api/v1/orders/:id',
      requestId: 'trace-123',
      statusCode: 200,
    });
    for (const value of [
      'TOPSECRET',
      'person@example',
      'private-order',
      'private-user',
      'private-session',
    ])
      expect(output).not.toContain(value);
  });

  it.each([401, 403, 429, 500, 503])(
    'records status %s even when a guard rejects before a controller',
    (status) => {
      const f = fixture(status);
      f.response.writableFinished = true;
      f.response.emit('finish');
      expect(f.observe).toHaveBeenCalledTimes(1);
      expect(f.observe).toHaveBeenCalledWith('GET', status, 45);
      if (status >= 500) expect(f.logger.error).toHaveBeenCalledTimes(1);
      else expect(f.logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  it('records a disconnect once without pretending it was a successful response', () => {
    const f = fixture();
    f.response.emit('close');
    f.response.emit('finish');
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.observe).toHaveBeenCalledWith('GET', 499, 45);
    expect(JSON.parse(f.logger.warn.mock.calls[0]?.[0] as string).event).toBe(
      'http.request.aborted',
    );
  });

  it('records an unexpected exception after headers as a server failure', () => {
    const f = fixture();
    f.request.internalHttpError = true;
    f.response.emit('close');
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.observe).toHaveBeenCalledWith('GET', 500, 45);
    expect(f.logger.error).toHaveBeenCalledTimes(1);
  });

  it('uses a constant unmatched label instead of logging arbitrary URL paths', () => {
    const f = fixture(404);
    f.request.route = undefined;
    expect(safeRouteTemplate(f.request)).toBe('unmatched');
    f.response.emit('finish');
    expect(f.logger.warn.mock.calls[0]?.[0]).not.toContain('TOPSECRET');
  });
});
