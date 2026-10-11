# SODA web app container.
#
#   docker build -f apps/web/Dockerfile -t soda-web .
#
# `next start` is used rather than a standalone bundle, because `soda-sdk` is a
# source-only workspace package that Next transpiles at build time. Tracing it
# into a standalone output adds a failure mode for no gain here.
#
# Needs at runtime (see apps/web/.env.example for the full list):
#   NEXT_PUBLIC_DEMO_CHAIN / DEMO_CHAIN        which chain the demo targets
#   NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL + bare    EVM RPC
#   NEXT_PUBLIC_SOLANA_RPC_URL + bare          Solana RPC
#   ANCHOR_WALLET_JSON                         server wallet, as a JSON array
#   MPC_COORDINATOR_URL + MPC_COORDINATOR_TOKEN   sign via the committee
#   SEPOLIA_FUNDER_KEY                         optional sponsor for /api/fund

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/soda-sdk/package.json packages/soda-sdk/

RUN pnpm install --filter web... --frozen-lockfile

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/soda-sdk/node_modules ./packages/soda-sdk/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY packages/soda-sdk ./packages/soda-sdk
COPY apps/web ./apps/web

# The page inlines NEXT_PUBLIC_* at build time, so they must be present here
# and not only at run time. Railway passes service variables to the build.
ARG NEXT_PUBLIC_DEMO_CHAIN
ARG NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
ARG NEXT_PUBLIC_SOLANA_RPC_URL
ARG NEXT_PUBLIC_SUI_CHAIN

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo/apps/web
RUN pnpm build

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/web ./apps/web
COPY --from=build /repo/packages/soda-sdk ./packages/soda-sdk
COPY --from=build /repo/pnpm-workspace.yaml /repo/package.json ./

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
WORKDIR /repo/apps/web
# Next reads $PORT, which Railway injects.
CMD ["pnpm", "start"]
