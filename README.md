# Excess

Excess is a real-time paper-trading platform built as a TypeScript modular monolith.

The first product milestone is a complete flow in which a user receives $10,000 in
virtual funds, watches a live BTC-USD chart, places a simulated market order, and
sees portfolio profit and loss update in real time.

The terminal now extends that flow to BTC-USD and ETH-USD while keeping one
account-wide balance, margin model, and risk engine.

## Architecture

- `apps/web` — Next.js browser application
- `apps/api` — NestJS modular-monolith API
- `packages/database` — Prisma schema and PostgreSQL client
- `packages/trading-engine` — deterministic order and position calculations
- `packages/risk-engine` — margin and account-risk calculations
- `packages/shared-types` — contracts shared by the browser and API

PostgreSQL is authoritative for users, balances, orders, trades, positions, price
alerts, and the financial ledger. Coinbase supplies public BTC-USD and ETH-USD candles and
live ticker updates; Redis caches normalized snapshots before the NestJS WebSocket gateway
fans them out to authenticated terminals.

## Requirements

- Node.js 22 or newer
- pnpm through Corepack
- Docker Desktop or another Docker-compatible runtime

## Local setup

```bash
cp .env.example .env
corepack pnpm install
docker compose up -d
corepack pnpm db:generate
corepack pnpm db:deploy
corepack pnpm dev
```

Run `corepack pnpm dlx clerk@latest init` from `apps/web` to link a Clerk
development application. Clerk writes credentials to the ignored
`apps/web/.env.local` file. Enable email/password and Google in the development
instance before testing sign-in.

The web application runs at `http://localhost:3000`. The API liveness endpoint is
available at `http://localhost:4000/api/v1/health`; the deployment readiness probe
is `http://localhost:4000/api/v1/health/ready`. Readiness requires PostgreSQL,
Redis, and a fresh live market-data ticker.

After signing in, open `http://localhost:3000/terminal` for live BTC-USD and
ETH-USD five-minute candlestick charts and a leveraged paper-trading order ticket. Market
buys fill at the current ask and sells fill at the current bid. Limit and stop
orders remain open until the live ticker crosses their price, and optional stop-loss/take-profit
orders protect filled positions as an OCO pair. The terminal shows open orders,
the open position, equity, unrealized P/L, used/free margin, and margin level on
every live price update. Select 1×, 2×, 5×, or 10× leverage per position. A margin
warning starts at 100%; at 50% the risk engine closes the position and prevents a
gap loss from making the demo balance negative. Set
`MARKET_DATA_PROVIDER=mock` for deterministic development or end-to-end tests
without an external feed.

The terminal also reports all-time realized performance and a newest-first,
cursor-paginated execution history. Realized results are derived from the immutable
financial ledger rather than maintained as a second balance source.

One-shot price alerts can watch for a move above or below a BTC-USD or ETH-USD target. A
trigger is recorded atomically with an outbox delivery event so repeated or
concurrent ticker processing cannot notify twice. The in-process outbox dispatcher
claims those events with recoverable leases, retries failures with exponential
backoff, and creates exactly one durable in-app notification per trigger. Set
`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and `ALERT_EMAIL_FROM` to deliver the
same alert by email. Provider retries use `price-alert-<outbox-event-id>` as the
Resend idempotency key, while local and test environments default to email disabled.

Set `ADMIN_EMAILS` to a comma-separated list of verified Clerk email addresses to
grant the persisted `ADMIN` role during session bootstrap. Administrators can open
`/admin` to inspect account activity and delivery health or requeue a failed event;
ordinary traders receive a stable `403` from the administration API.

Authenticated API traffic is protected by a Redis-backed fixed-window rate limit,
with a per-process in-memory fallback when Redis cannot be reached. Configure the
quota with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_SECONDS`. Every HTTP response
includes a correlation ID and defensive browser headers, and every completed API
request produces a structured log record. Liveness and readiness probes are exempt
from rate limiting.

Prometheus-compatible process, HTTP, outbox, and email metrics are available at
`GET /api/v1/metrics`. Set `METRICS_BEARER_TOKEN` and configure the scraper to
send it as a bearer token; the token is mandatory in production. A sample scrape
configuration lives in `ops/prometheus/prometheus.yml.example`.

The authenticated trading interface is:

- `GET /api/v1/market-data/instruments` — list supported instruments and quotes
- `GET /api/v1/market-data/instruments/:symbol` — load one instrument and quote
- `GET /api/v1/market-data/instruments/:symbol/candles` — load five-minute history
- `POST /api/v1/trading/orders` — place an idempotent market, limit, or stop order
- `GET /api/v1/trading/orders/open` — load accepted pending/protection orders
- `DELETE /api/v1/trading/orders/:orderId` — cancel an accepted order
- `GET /api/v1/trading/portfolio` — load balance, equity, and open positions
- `GET /api/v1/trading/trades` — load cursor-paginated execution history
- `GET /api/v1/trading/performance` — load all-time execution and realized metrics
- `POST /api/v1/alerts` — create a one-shot price alert for a supported instrument
- `GET /api/v1/alerts` — list active, triggered, and cancelled alerts
- `DELETE /api/v1/alerts/:alertId` — cancel an active alert
- `GET /api/v1/notifications` — list recent in-app notifications and unread count
- `PATCH /api/v1/notifications/:notificationId/read` — mark one notification read
- `POST /api/v1/notifications/read-all` — mark every notification read
- `GET /api/v1/admin/overview` — load administrator operations metrics
- `POST /api/v1/admin/deliveries/:eventId/retry` — requeue a failed delivery

## Quality checks

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:e2e
```

Run the authenticated API load profile with a short-lived Clerk session token:

```bash
K6_AUTH_TOKEN=... corepack pnpm test:load
```

Override `K6_BASE_URL`, `K6_VUS`, `K6_RAMP_UP`, `K6_DURATION`, and
`K6_RAMP_DOWN` for staging. The profile fails when request errors reach 1%, p95
latency reaches 500 ms, or p99 latency reaches one second.

## Deployment

The NestJS API has a production container in `Dockerfile` and Railway
Infrastructure as Code in `.railway/railway.ts`. Run `railway config plan` to
review the API, PostgreSQL, and Redis resources, then `railway config apply` when
the plan is correct. Add the preserved production secrets before deployment.
Migrations run as Railway's pre-deploy command and readiness is checked before
traffic moves.

Connect the same repository to Vercel using the repository root; `vercel.json`
builds only `@excess/web`. Configure the public Clerk values, `NEXT_PUBLIC_API_URL`,
and `NEXT_PUBLIC_WS_URL` with the deployed API origins. Set `WEB_ORIGIN` on Railway
to the final Vercel or custom-domain origin.

## Development order

1. Foundation and local infrastructure
2. Authentication and the $10,000 demo account
3. Live BTC-USD market data and chart — complete
4. Atomic market-order execution — complete
5. Positions and real-time portfolio P/L — complete for BTC-USD
6. Pending orders: limit, stop, stop-loss, and take-profit — complete for BTC-USD
7. Leverage, margin, liquidation, and negative-balance protection — complete for BTC-USD
8. Persistent one-shot price alerts — complete for BTC-USD
9. Request correlation, structured logging, rate limiting, and readiness — complete
10. Durable in-app alert delivery and administration — complete
11. Email delivery, Prometheus observability, deployment artifacts, and load testing — complete
12. Multi-instrument market data, trading, portfolio risk, and alerts — complete for BTC-USD and ETH-USD
13. Paginated trade history and account performance analytics — complete

Excess is paper trading software. It does not hold funds or place orders on a real
exchange.
