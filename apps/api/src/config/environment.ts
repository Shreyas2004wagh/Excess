import { z } from 'zod';

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    PORT: z.coerce.number().int().positive().optional(),
    WEB_ORIGIN: z.url().default('http://localhost:3000'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    ADMIN_EMAILS: z.string().default(''),
    EMAIL_PROVIDER: z.enum(['disabled', 'resend']).default('disabled'),
    RESEND_API_URL: z.url().default('https://api.resend.com'),
    RESEND_API_KEY: optionalSecret,
    ALERT_EMAIL_FROM: optionalSecret,
    METRICS_BEARER_TOKEN: optionalSecret,
    MARKET_DATA_PROVIDER: z.enum(['coinbase', 'mock']).default('coinbase'),
    COINBASE_REST_URL: z.url().default('https://api.exchange.coinbase.com'),
    COINBASE_WS_URL: z.url().default('wss://advanced-trade-ws.coinbase.com'),
    CLERK_SECRET_KEY: z.string().min(1),
    // Runtime production builds may still host the explicitly permitted demo.
    CLERK_ENVIRONMENT: z
      .enum(['development', 'production'])
      .default('development'),
    CLERK_PUBLISHABLE_KEY: optionalSecret,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: optionalSecret,
    CLERK_WEBHOOK_SIGNING_SECRET: optionalSecret,
  })
  .superRefine((environment, context) => {
    const publishableKey =
      environment.CLERK_PUBLISHABLE_KEY ??
      environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (
      environment.CLERK_ENVIRONMENT === 'development' &&
      (environment.CLERK_SECRET_KEY.startsWith('sk_live_') ||
        publishableKey?.startsWith('pk_live_'))
    ) {
      issue(
        'CLERK_ENVIRONMENT',
        'Live keys require explicit production authentication configuration',
      );
    }
    if (
      environment.CLERK_PUBLISHABLE_KEY &&
      environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
      environment.CLERK_PUBLISHABLE_KEY !==
        environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    ) {
      issue(
        'CLERK_PUBLISHABLE_KEY',
        'Clerk publishable keys must identify the same instance',
      );
    }
    if (
      (environment.CLERK_SECRET_KEY.startsWith('sk_live_') &&
        publishableKey?.startsWith('pk_test_')) ||
      (environment.CLERK_SECRET_KEY.startsWith('sk_test_') &&
        publishableKey?.startsWith('pk_live_'))
    ) {
      issue(
        'CLERK_SECRET_KEY',
        'Clerk secret and publishable keys must use the same environment',
      );
    }
    if (environment.CLERK_ENVIRONMENT === 'production') {
      if (!environment.CLERK_SECRET_KEY.startsWith('sk_live_'))
        issue(
          'CLERK_SECRET_KEY',
          'A live Clerk secret key is required for production authentication',
        );
      if (!publishableKey?.startsWith('pk_live_'))
        issue(
          'CLERK_PUBLISHABLE_KEY',
          'A live Clerk publishable key is required for production authentication',
        );
      let origin: URL | undefined;
      try {
        origin = new URL(environment.WEB_ORIGIN);
      } catch {
        /* z.url reports invalid URLs without echoing values. */
      }
      if (
        !origin ||
        origin.protocol !== 'https:' ||
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash
      )
        issue(
          'WEB_ORIGIN',
          'Production authentication requires a public HTTPS origin without a path or credentials',
        );
      if (
        !/^whsec_[A-Za-z0-9+/=_-]{32,}$/.test(
          environment.CLERK_WEBHOOK_SIGNING_SECRET ?? '',
        )
      )
        issue(
          'CLERK_WEBHOOK_SIGNING_SECRET',
          'A valid webhook signing-secret format is required for production authentication',
        );
    }
    if (
      !environment.CLERK_PUBLISHABLE_KEY &&
      !environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A Clerk publishable key is required',
        path: ['CLERK_PUBLISHABLE_KEY'],
      });
    }

    if (
      environment.NODE_ENV === 'production' &&
      !environment.CLERK_WEBHOOK_SIGNING_SECRET
    ) {
      context.addIssue({
        code: 'custom',
        message: 'CLERK_WEBHOOK_SIGNING_SECRET is required in production',
        path: ['CLERK_WEBHOOK_SIGNING_SECRET'],
      });
    }

    if (environment.EMAIL_PROVIDER === 'resend') {
      if (!environment.RESEND_API_KEY) {
        context.addIssue({
          code: 'custom',
          message: 'RESEND_API_KEY is required when email delivery is enabled',
          path: ['RESEND_API_KEY'],
        });
      }
      if (!environment.ALERT_EMAIL_FROM) {
        context.addIssue({
          code: 'custom',
          message:
            'ALERT_EMAIL_FROM is required when email delivery is enabled',
          path: ['ALERT_EMAIL_FROM'],
        });
      }
    }

    if (
      environment.NODE_ENV === 'production' &&
      !environment.METRICS_BEARER_TOKEN
    ) {
      context.addIssue({
        code: 'custom',
        message: 'METRICS_BEARER_TOKEN is required in production',
        path: ['METRICS_BEARER_TOKEN'],
      });
    }
  });

export function validateEnvironment(configuration: Record<string, unknown>) {
  const result = environmentSchema.safeParse(configuration);

  if (!result.success) {
    throw new Error(
      `Invalid environment configuration: ${z.prettifyError(result.error)}`,
    );
  }

  return result.data;
}
