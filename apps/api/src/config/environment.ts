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
    CLERK_PUBLISHABLE_KEY: optionalSecret,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: optionalSecret,
    CLERK_WEBHOOK_SIGNING_SECRET: optionalSecret,
  })
  .superRefine((environment, context) => {
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
