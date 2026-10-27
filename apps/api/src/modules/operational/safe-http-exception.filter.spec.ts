import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';

import { SafeHttpExceptionFilter } from './safe-http-exception.filter.js';

function fixture(headersSent = false) {
  const request = { requestId: 'safe-trace', internalHttpError: false };
  const response = {
    headersSent,
    status: jest.fn(),
    json: jest.fn(),
    end: jest.fn(),
  };
  response.status.mockReturnValue(response);
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { request, response, host };
}

describe('SafeHttpExceptionFilter', () => {
  it('returns a generic error with a trace ID, never the raw unknown error', () => {
    const f = fixture();
    new SafeHttpExceptionFilter().catch(
      new Error('postgresql://user:password@host/database; private email'),
      f.host,
    );
    expect(f.request.internalHttpError).toBe(true);
    expect(f.response.status).toHaveBeenCalledWith(500);
    expect(f.response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
      requestId: 'safe-trace',
    });
    expect(JSON.stringify(f.response.json.mock.calls)).not.toContain(
      'password',
    );
  });

  it.each([
    new BadRequestException({
      code: 'INVALID_ORDER',
      message: 'Invalid order',
    }),
    new ServiceUnavailableException({
      code: 'MARKET_DATA_UNAVAILABLE',
      message: 'Market data is unavailable',
    }),
  ])('preserves deliberate API exception contracts', (error) => {
    const f = fixture();
    new SafeHttpExceptionFilter().catch(error, f.host);
    expect(f.response.status).toHaveBeenCalledWith(error.getStatus());
    expect(f.response.json).toHaveBeenCalledWith(error.getResponse());
    expect(f.request.internalHttpError).toBe(false);
  });

  it('does not attempt a second header/body write after headers were sent', () => {
    const f = fixture(true);
    new SafeHttpExceptionFilter().catch(new Error('secret'), f.host);
    expect(f.response.end).toHaveBeenCalledTimes(1);
    expect(f.response.json).not.toHaveBeenCalled();
    expect(f.request.internalHttpError).toBe(true);
  });
});
