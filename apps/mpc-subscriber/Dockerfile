# SODA mpc-subscriber container.
#
#   docker build -f apps/mpc-subscriber/Dockerfile -t soda-mpc-subscriber .
#
# Needs at runtime:
#   SOLANA_RPC_URL          devnet RPC
#   MPC_COORDINATOR_URL     the coordinator this subscriber drives
#   MPC_COORDINATOR_TOKEN   bearer token the coordinator requires
#   ANCHOR_WALLET_JSON      fee-payer keypair, as the 64-number JSON array

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/mpc-subscriber/package.json apps/mpc-subscriber/
COPY packages/soda-sdk/package.json packages/soda-sdk/

RUN pnpm install --filter mpc-subscriber... --frozen-lockfile

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/mpc-subscriber/node_modules ./apps/mpc-subscriber/node_modules
# soda-sdk is source-only, so its own dependencies (@noble/*) are resolved
# from here at runtime, not bundled.
COPY --from=deps /repo/packages/soda-sdk/node_modules ./packages/soda-sdk/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY packages/soda-sdk ./packages/soda-sdk
COPY apps/mpc-subscriber ./apps/mpc-subscriber
# The committed IDLs. `contracts/target/idl/` is a build output and is not in
# the repo, so `idlPath()` falls back to these.
COPY apps/web/lib/idl ./apps/web/lib/idl

ENV NODE_ENV=production
WORKDIR /repo/apps/mpc-subscriber
CMD ["pnpm", "start"]
