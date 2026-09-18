# SODA relayer container.
#
#   docker build -f apps/relayer/Dockerfile -t soda-relayer .
#
# Needs at runtime:
#   SOLANA_RPC_URL    devnet RPC (the WebSocket URL is derived from it)
#   SEPOLIA_RPC_URL   the EVM RPC it broadcasts to
#   DEMO_CHAIN        which EVM chain that RPC serves, e.g. base-sepolia
#   SUI_CHAIN         optional, enables the Sui broadcast path

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/relayer/package.json apps/relayer/
COPY packages/soda-sdk/package.json packages/soda-sdk/

RUN pnpm install --filter relayer... --frozen-lockfile

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/relayer/node_modules ./apps/relayer/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY packages/soda-sdk ./packages/soda-sdk
COPY apps/relayer ./apps/relayer
# The committed IDLs. `contracts/target/idl/` is a build output and is not in
# the repo, so `idlPath()` falls back to these.
COPY apps/web/lib/idl ./apps/web/lib/idl

ENV NODE_ENV=production
WORKDIR /repo/apps/relayer
CMD ["pnpm", "start"]
