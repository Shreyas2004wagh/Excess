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
});
