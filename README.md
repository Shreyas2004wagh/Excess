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

PostgreSQL is authoritative for users, balances, orders, trades, positions, and
the financial ledger. Coinbase supplies public BTC-USD candles and live ticker
updates; Redis caches normalized snapshots before the NestJS WebSocket gateway
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

The web application runs at `http://localhost:3000`. The API health endpoint is
available at `http://localhost:4000/api/v1/health`.

After signing in, open `http://localhost:3000/terminal` for the live BTC-USD
five-minute candlestick chart and 1× paper-trading order ticket. Market buys fill
at the current ask and sells fill at the current bid. The terminal shows the open
position, equity, and unrealized P/L on every live price update. Set
`MARKET_DATA_PROVIDER=mock` for deterministic development or end-to-end tests
without an external feed.

The authenticated trading interface is:

- `POST /api/v1/trading/orders` — place an idempotent BTC-USD market order
- `GET /api/v1/trading/portfolio` — load balance, equity, and open positions

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
6. Pending orders: limit, stop, stop-loss, and take-profit
7. Margin, liquidation, and production hardening

Excess is paper trading software. It does not hold funds or place orders on a real
exchange.
