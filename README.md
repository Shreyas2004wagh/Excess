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

Open `/reports` for UTC date and instrument filters, daily realized results,
execution totals, traded notional, recorded fees, and a full-range CSV download.
Reports default to the last 30 UTC calendar days and allow up to 366 days.
Both date endpoints are inclusive. Successful filters persist in the page URL.
Pagination and downloads reuse the returned execution-time `asOf` cutoff, so
executions after that cutoff are excluded. Each request uses a repeatable-read
transaction; `asOf` is not a persisted database snapshot, so transactions that
commit late with an earlier execution timestamp can appear on subsequent reads.
Apply the filters again to refresh the cutoff.

Credited realized P/L is the sum of `REALIZED_PNL` ledger amounts linked to the
selected executions, including any negative-balance protection. It excludes
unrealized P/L, opening credits, and adjustments. Fees are reported separately;
the report does not compute an additional net-after-fees metric. Daily cumulative P/L starts at zero for the selected
period; it is not account equity or a balance history. An execution without a
realized ledger entry displays `—` and exports an empty realized-P/L cell; this
does not distinguish an opening trade from a break-even close.

The CSV contains every matching execution, not just the visible page, and retains
full decimal precision. Exports over 10,000 rows fail with
`REPORT_EXPORT_TOO_LARGE`; narrow the range or instrument instead of receiving
silently truncated data. Reports are private, uncached, and available only to the
authenticated account owner. No additional service or migration is needed.

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
- `GET /api/v1/reports/trading` — load filtered totals, daily results, and executions
- `GET /api/v1/reports/trading/export` — download all filtered executions as CSV
- `POST /api/v1/alerts` — create a one-shot price alert for a supported instrument
- `GET /api/v1/alerts` — list active, triggered, and cancelled alerts
- `DELETE /api/v1/alerts/:alertId` — cancel an active alert
- `GET /api/v1/notifications` — list recent in-app notifications and unread count
- `PATCH /api/v1/notifications/:notificationId/read` — mark one notification read
- `POST /api/v1/notifications/read-all` — mark every notification read
- `GET /api/v1/admin/overview` — load administrator operations metrics
- `POST /api/v1/admin/deliveries/:eventId/retry` — requeue a failed delivery

Report queries accept `from=YYYY-MM-DD`, `to=YYYY-MM-DD`, optional
`symbol=BTC-USD|ETH-USD`, and optional `asOf=<UTC ISO timestamp>`. JSON reports
also accept `limit=1..100` (default 20) and `cursor=<execution UUID>`; cursor
requests must include the original `asOf` value and should reuse the other filters.
CSV requests must omit `cursor` and `limit`. Invalid filters return
`INVALID_REPORT_QUERY` (400); cursors outside the account/range return
`INVALID_REPORT_CURSOR` (400). Suspended identities and non-active accounts
cannot read or export reports.

## Quality checks

The web workspace uses a shared graphite-and-lime design system, self-hosted Geist
fonts, persistent desktop navigation, and a compact mobile tab bar. The public
landing-page chart is explicitly illustrative; authenticated dashboard quotes and
portfolio metrics are page-load snapshots, while the terminal streams live updates.
The reports chart visualizes cumulative credited realized P/L for the selected
period, starting at zero; it is not an equity curve.

Frontend checks cover keyboard skip links, active navigation, reduced motion,
mobile/tablet/desktop overflow, chart reset, protective-order controls, loaded
Clerk sign-up fields, and signed ledger amounts. Playwright also exercises existing
trading, alert, report/export, and administrative flows. Its authenticated fixtures
share one test account, so the suite runs with one worker. Screenshot artifacts are
written to `apps/web/test-results/` for visual inspection, not committed baselines.

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
14. Date-filtered trading reports, daily results, and CSV export — complete
15. Responsive frontend redesign: landing, authentication, shared workspace,
    account overview, trading terminal, and realized-performance chart — complete

Excess is paper trading software. It does not hold funds or place orders on a real
exchange.
