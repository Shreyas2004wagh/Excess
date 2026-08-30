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
the financial ledger. Redis will support market-price caching and WebSocket fan-out.

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
corepack pnpm db:push
corepack pnpm dev
```

The web application runs at `http://localhost:3000`. The API health endpoint is
available at `http://localhost:4000/api/v1/health`.

## Quality checks

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## Development order

1. Foundation and local infrastructure
2. Authentication and the $10,000 demo account
3. Live BTC-USD market data and chart
4. Atomic market-order execution
5. Positions and real-time portfolio P/L
6. Production hardening

Excess is paper trading software. It does not hold funds or place orders on a real
exchange.
