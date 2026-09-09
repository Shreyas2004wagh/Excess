import { describe, expect, it } from '@jest/globals';

import { validateEnvironment } from './environment.js';

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://localhost/excess',
  CLERK_SECRET_KEY: 'sk_test_placeholder',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_placeholder',
};

describe('validateEnvironment', () => {
  it('treats empty optional secrets as absent in development', () => {
    expect(
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: 'development',
        CLERK_WEBHOOK_SIGNING_SECRET: '',
      }),
    ).toMatchObject({
      NODE_ENV: 'development',
      CLERK_WEBHOOK_SIGNING_SECRET: undefined,
    });
  });

  it('requires the Clerk webhook secret in production', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: 'production',
        CLERK_WEBHOOK_SIGNING_SECRET: '',
      }),
    ).toThrow('CLERK_WEBHOOK_SIGNING_SECRET');
  });

  it('loads safe rate-limit defaults and validates overrides', () => {
    expect(validateEnvironment(requiredEnvironment)).toMatchObject({
      RATE_LIMIT_MAX: 120,
      RATE_LIMIT_WINDOW_SECONDS: 60,
      ADMIN_EMAILS: '',
      EMAIL_PROVIDER: 'disabled',
    });
    expect(() =>
      validateEnvironment({ ...requiredEnvironment, RATE_LIMIT_MAX: 0 }),
    ).toThrow('RATE_LIMIT_MAX');
  });

  it('requires complete Resend configuration when email delivery is enabled', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        EMAIL_PROVIDER: 'resend',
      }),
    ).toThrow('RESEND_API_KEY');

    expect(
      validateEnvironment({
        ...requiredEnvironment,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_placeholder',
        ALERT_EMAIL_FROM: 'Excess <alerts@example.com>',
      }),
    ).toMatchObject({ EMAIL_PROVIDER: 'resend' });
  });

  it('requires a metrics token in production', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: 'production',
        CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_placeholder',
      }),
    ).toThrow('METRICS_BEARER_TOKEN');
  });
});
