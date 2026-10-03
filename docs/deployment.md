# Hosted demo deployment

- Frontend: <https://excess-psi.vercel.app> (Vercel)
- API readiness: <https://excess-demo-api.onrender.com/api/v1/health/ready> (Render)
- Database: Neon PostgreSQL 17, Singapore, Free plan
- Cache/rate limiting: Render Key Value, Singapore, Free plan
- Identity: Clerk development instance

This is a full-stack paper-trading demo, not a static mock or a production financial service. Hosting plans have quotas; free availability is not an uptime guarantee.

## Vercel frontend

Import the monorepo and select the Next.js framework. Set **Root Directory** to `apps/web` and allow access to source files outside that directory for the shared workspace package. Set the project's build overrides to match `vercel.json`:

```text
Install: pnpm install --frozen-lockfile
Build: pnpm --filter @excess/shared-types build && pnpm --filter @excess/web build
Output: .next
```

Because the configuration file lives at the repository root, set these overrides explicitly in the Vercel project when using `apps/web` as its root. The shared-types build is required before Next.js resolves the workspace package. `.vercelignore` excludes local caches, generated build artifacts, and environment files from CLI uploads; `.vercel` project metadata stays git-ignored.

Set these environment variables in Vercel, not in committed files:

```dotenv
NEXT_PUBLIC_API_URL=https://excess-demo-api.onrender.com/api/v1
NEXT_PUBLIC_WS_URL=https://excess-demo-api.onrender.com
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<your Clerk publishable key>
CLERK_SECRET_KEY=<your Clerk secret key>
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard
```

Use your own deployment origins when deploying a fork. Public API/WS origins are not secret; the Clerk secret key is.

## Render API

Create a Node web service from the repository, with its root at the repository root. The current demo uses Node 24 and the Free instance type. The service binds to Render's `PORT`.

Build command:

```bash
corepack pnpm install --frozen-lockfile && corepack pnpm db:generate && corepack pnpm --filter @excess/shared-types build && corepack pnpm --filter @excess/database build && corepack pnpm --filter @excess/risk-engine build && corepack pnpm --filter @excess/trading-engine build && corepack pnpm --filter @excess/api build
```

Start command:

```bash
DATABASE_URL="$DATABASE_URL_UNPOOLED" corepack pnpm db:deploy && corepack pnpm --filter @excess/api start
```

The inline assignment applies the **direct** URL only to the migration command; the API then inherits the **pooled** `DATABASE_URL`. A failed migration prevents the API from starting. Use committed migrations, not `db push`.

Required service configuration:

```dotenv
NODE_ENV=production
NODE_VERSION=24.21.0
WEB_ORIGIN=https://excess-psi.vercel.app
DATABASE_URL=<Neon pooled URL with SSL>
DATABASE_URL_UNPOOLED=<Neon direct URL with SSL>
REDIS_URL=<Render Key Value internal connection URL>
CLERK_SECRET_KEY=<same Clerk instance as frontend>
CLERK_PUBLISHABLE_KEY=<same Clerk instance as frontend>
CLERK_WEBHOOK_SIGNING_SECRET=<actual Clerk endpoint signing secret when enabling webhooks>
METRICS_BEARER_TOKEN=<strong random secret>
MARKET_DATA_PROVIDER=coinbase
EMAIL_PROVIDER=disabled
```

Startup requires a webhook-signing value even when no webhook subscription is configured. The current demo's placeholder does not constitute a working webhook integration: replace it with Clerk's actual endpoint secret and configure `/api/v1/webhooks/clerk` before relying on identity-deletion events. Do not bypass signature verification.

The currently hosted API has auto-deploy disabled. A GitHub push updates the repository but does not release the API; explicitly deploy the intended commit after reviewing it.

## Neon connections and migration safety

Enable the connection pooler. Use its `-pooler` hostname for the API, and the non-pooled hostname for Prisma migrations and `pg_dump`/`pg_restore`. The demo uses `sslmode=require`, `connect_timeout=30`, `connection_limit=3`, `pool_timeout=20`, and `schema=public`. The migration connection omits `channel_binding=require` for compatibility with the existing Prisma 6 schema engine; TLS remains required.

Keep the database in Singapore near the Render API. The demo compute is capped at 0.25 CU; usage still counts against the Free plan allowance. Application polling can keep database compute active while the API is running, so review usage rather than assuming scale-to-zero removes all consumption.

For an existing database, pause application writes, export with `pg_dump -Fc`, restore into an empty destination over its direct connection with `--no-owner --no-acl`, and compare source/destination data before changing connection strings. Skip the archive's `CREATE SCHEMA public` entry if that schema already exists; do not drop an active schema to work around it. Preserve Prisma migration records and verify `prisma migrate status`.

Keep exports outside the public repository with restricted permissions. Retain the source until verification succeeds. A retained source is a point-in-time rollback option, not a replica of new writes after cutover.

## Verification and limitations

Check `/api/v1/health/ready` for database, Redis, and market-data readiness. Verify anonymous dashboard redirects, authenticated bootstrap, balance and opening ledger credit, portfolio/trade history, a live WebSocket feed, and refresh persistence. Use a dedicated test identity; any test trade must use virtual funds only.

After the Neon migration, all 12 public tables matched source row counts and content hashes, all eight migrations were recognized, and the existing 0.001 BTC position and trade were preserved. Hosted authentication, account/ledger/portfolio/trade endpoints, live prices, and refresh passed smoke checks.

Known demo limitations:

- Render's free API spins down after 15 minutes without inbound traffic and can take about a minute to wake.
- Render's free Key Value is in-memory only; its cache/rate-limit state can be lost on restart. Financial records remain in PostgreSQL.
- Clerk development authentication is intentional for this demo. Production keys, Google credentials, and webhooks remain deployment tasks.
- Email delivery is disabled. In-app notifications remain available.
- Free-plan quotas and backup capabilities require review; this setup has no production availability commitment.

Provider references: [Render free instances](https://render.com/docs/free), [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [Render-to-Neon migration](https://neon.com/docs/import/migrate-from-render), and [Clerk production deployment](https://clerk.com/docs/guides/development/deployment/production).
