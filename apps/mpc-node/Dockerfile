# SODA mpc-node container.
#
# Build context expects to be run from the repo root so pnpm workspace
# resolution works:
#
#   docker build -f apps/mpc-node/Dockerfile -t soda-mpc-node .
#
# At runtime, mount /data with the share file (share-p1.json or
# share-p2.json) and set MPC_ROLE + MPC_SHARE_PATH accordingly.

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo

# Copy workspace metadata first so the layer can be cached across deps changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/mpc-node/package.json apps/mpc-node/

# Install only what mpc-node needs.
RUN pnpm install --filter mpc-node... --frozen-lockfile

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/mpc-node/node_modules ./apps/mpc-node/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY apps/mpc-node ./apps/mpc-node

ENV NODE_ENV=production
EXPOSE 8001 8002
WORKDIR /repo/apps/mpc-node
CMD ["pnpm", "start"]
