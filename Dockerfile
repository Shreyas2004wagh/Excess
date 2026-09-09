FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/risk-engine/package.json packages/risk-engine/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/trading-engine/package.json packages/trading-engine/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages packages
RUN pnpm db:generate \
  && pnpm --filter @excess/shared-types build \
  && pnpm --filter @excess/database build \
  && pnpm --filter @excess/risk-engine build \
  && pnpm --filter @excess/trading-engine build \
  && pnpm --filter @excess/api build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY --from=build /app /app

EXPOSE 4000
CMD ["pnpm", "--filter", "@excess/api", "start"]
