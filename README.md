# Excess

Excess is a real-time paper-trading platform built as a TypeScript modular monolith.

The first product milestone is a complete flow in which a user receives $10,000 in
virtual funds, watches a live BTC-USD chart, places a simulated market order, and
sees portfolio profit and loss update in real time.

## Architecture

- `apps/web` — Next.js browser application
- `apps/api` — NestJS modular-monolith API
- `packages/database` — Prisma schema and PostgreSQL client
- `packages/trading-engine` — deterministic order and position calculations
- `packages/risk-engine` — margin and account-risk calculations
- `packages/shared-types` — contracts shared by the browser and API

PostgreSQL is authoritative for users, balances, orders, trades, positions, price
alerts, and the financial ledger. Coinbase supplies public BTC-USD candles and
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

After signing in, open `http://localhost:3000/terminal` for the live BTC-USD
five-minute candlestick chart and leveraged paper-trading order ticket. Market
buys fill at the current ask and sells fill at the current bid. Limit and stop
orders remain open until the live ticker crosses their price, and optional stop-loss/take-profit
orders protect filled positions as an OCO pair. The terminal shows open orders,
the open position, equity, unrealized P/L, used/free margin, and margin level on
every live price update. Select 1×, 2×, 5×, or 10× leverage per position. A margin
warning starts at 100%; at 50% the risk engine closes the position and prevents a
gap loss from making the demo balance negative. Set
`MARKET_DATA_PROVIDER=mock` for deterministic development or end-to-end tests
without an external feed.

One-shot price alerts can watch for a move above or below a BTC-USD target. A
trigger is recorded atomically with an outbox delivery event so repeated or
concurrent ticker processing cannot notify twice. The in-process outbox dispatcher
claims those events with recoverable leases, retries failures with exponential
backoff, and creates exactly one durable in-app notification per trigger.

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

The authenticated trading interface is:

- `POST /api/v1/trading/orders` — place an idempotent market, limit, or stop order
- `GET /api/v1/trading/orders/open` — load accepted pending/protection orders
- `DELETE /api/v1/trading/orders/:orderId` — cancel an accepted order
- `GET /api/v1/trading/portfolio` — load balance, equity, and open positions
- `POST /api/v1/alerts` — create a one-shot BTC-USD price alert
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
11. Email delivery, external observability, deployment, and load testing

Excess is paper trading software. It does not hold funds or place orders on a real
exchange.
