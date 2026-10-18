import { describe, expect, it } from '@jest/globals';

import { validateEnvironment } from './environment.js';

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://localhost/excess',
  CLERK_SECRET_KEY: 'sk_test_placeholder',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_placeholder',
};

describe('validateEnvironment', () => {
  const productionAuthentication = {
    ...requiredEnvironment,
    CLERK_ENVIRONMENT: 'production',
    CLERK_SECRET_KEY: 'sk_live_fixture',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_fixture',
    WEB_ORIGIN: 'https://trade.example.com',
    CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${'a'.repeat(44)}`,
  };

  it('keeps development authentication available for the hosted demo explicitly', () => {
    expect(
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: 'production',
        CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_demo',
        METRICS_BEARER_TOKEN: 'fixture',
      }).CLERK_ENVIRONMENT,
    ).toBe('development');
  });

  it('validates live keys and a complete production authentication configuration', () => {
    expect(
      validateEnvironment(productionAuthentication).CLERK_ENVIRONMENT,
    ).toBe('production');
    expect(() =>
      validateEnvironment({
        ...productionAuthentication,
        CLERK_SECRET_KEY: 'sk_test_fixture',
      }),
    ).toThrow('CLERK_SECRET_KEY');
    expect(() =>
      validateEnvironment({
        ...productionAuthentication,
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
      }),
    ).toThrow('CLERK_PUBLISHABLE_KEY');
    expect(() =>
      validateEnvironment({
        ...productionAuthentication,
        CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_placeholder',
      }),
    ).toThrow('CLERK_WEBHOOK_SIGNING_SECRET');
  });

  it('does not silently use live keys with the demo configuration', () => {
    expect(() =>
      validateEnvironment({
        ...productionAuthentication,
        CLERK_ENVIRONMENT: 'development',
      }),
    ).toThrow('CLERK_ENVIRONMENT');
  });

  it.each([
    'http://trade.example.com',
    'https://localhost',
    'https://trade.example.com/path',
    'https://user:password@trade.example.com',
    'https://trade.example.com?token=value',
  ])('rejects unsafe production origin %s', (WEB_ORIGIN) => {
    expect(() =>
      validateEnvironment({ ...productionAuthentication, WEB_ORIGIN }),
    ).toThrow('WEB_ORIGIN');
  });

  it('rejects mixed environments or disagreeing publishable keys without printing them', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        CLERK_SECRET_KEY: 'sk_live_private-fixture',
      }),
    ).toThrow('same environment');
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        CLERK_PUBLISHABLE_KEY: 'pk_test_other',
      }),
    ).toThrow('same instance');
    try {
      validateEnvironment({
        ...productionAuthentication,
        CLERK_SECRET_KEY: 'sk_test_private-fixture',
      });
    } catch (error) {
      expect(String(error)).not.toContain('sk_test_private-fixture');
    }
  });
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
