# SODA mpc-coordinator container.
#
#   docker build -f apps/mpc-coordinator/Dockerfile -t soda-mpc-coordinator .

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/mpc-coordinator/package.json apps/mpc-coordinator/

RUN pnpm install --filter mpc-coordinator... --frozen-lockfile

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/mpc-coordinator/node_modules ./apps/mpc-coordinator/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY apps/mpc-coordinator ./apps/mpc-coordinator

ENV NODE_ENV=production
EXPOSE 8000
WORKDIR /repo/apps/mpc-coordinator
CMD ["pnpm", "start"]
