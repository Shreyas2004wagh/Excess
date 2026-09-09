import {
  defineRailway,
  github,
  group,
  postgres,
  preserve,
  project,
  redis,
  service,
} from 'railway/iac';

export default defineRailway(() => {
  const database = postgres('postgres');
  const cache = redis('redis');
  const api = service('api', {
    source: github('Shreyas2004wagh/Excess', { branch: 'main' }),
    start: 'pnpm --filter @excess/api start',
    preDeploy: 'pnpm db:deploy',
    healthcheck: '/api/v1/health/ready',
    healthcheckTimeout: 300,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: database.env.DATABASE_URL,
      REDIS_URL: cache.env.REDIS_URL,
      MARKET_DATA_PROVIDER: 'coinbase',
      EMAIL_PROVIDER: 'resend',
      WEB_ORIGIN: preserve(),
      ADMIN_EMAILS: preserve(),
      CLERK_SECRET_KEY: preserve(),
      CLERK_PUBLISHABLE_KEY: preserve(),
      CLERK_WEBHOOK_SIGNING_SECRET: preserve(),
      RESEND_API_KEY: preserve(),
      ALERT_EMAIL_FROM: preserve(),
      METRICS_BEARER_TOKEN: preserve(),
    },
  });

  return project('excess', {
    resources: [group('Backend', [api, database, cache])],
  });
});
