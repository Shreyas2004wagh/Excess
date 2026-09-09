import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { AlertEmailService } from './alert-email.service.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function configuration(values: Record<string, string>) {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      const value = values[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;
}

describe('AlertEmailService', () => {
  it('sends through Resend with a stable idempotency key', async () => {
    const fetchMock = jest.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 'email_123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const service = new AlertEmailService(
      configuration({
        EMAIL_PROVIDER: 'resend',
        RESEND_API_URL: 'https://api.resend.com',
        RESEND_API_KEY: 're_test',
        ALERT_EMAIL_FROM: 'Excess <alerts@example.com>',
      }),
    );

    await expect(
      service.send({
        to: 'trader@example.com',
        subject: 'BTC-USD price alert triggered',
        message: 'BTC-USD reached $70,000.',
        outboxEventId: 'event-123',
      }),
    ).resolves.toBe('email_123');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Idempotency-Key': 'price-alert-event-123',
        }),
      }),
    );
  });

  it('stays explicitly disabled without provider credentials', () => {
    const service = new AlertEmailService(
      configuration({
        EMAIL_PROVIDER: 'disabled',
        RESEND_API_URL: 'https://api.resend.com',
      }),
    );
    expect(service.enabled).toBe(false);
  });
});
