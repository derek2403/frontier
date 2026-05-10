## Access Instructions

### 1. Install the SDK

```bash
pnpm add @soda-sdk/core
# or: npm install @soda-sdk/core
# or: yarn add @soda-sdk/core
```

Published on npm: https://www.npmjs.com/package/@soda-sdk/core

### 2. Read the Documentation

Full SDK reference, concepts, and an end-to-end walkthrough live in the
`apps/docs` Nextra site. Run it locally:

```bash
pnpm install
pnpm docs:dev
# open http://localhost:3001
```

The walkthrough most worth opening: **Sign an Ethereum tx** under
`/guides/sign-an-eth-tx`. It covers derivation, requesting a signature on
Solana, listening for `SigCompleted`, and broadcasting to Sepolia.

### 3. Run the End-to-End Demo

A Solana program signs and broadcasts a real Sepolia transaction via the
SODA primitive.

```bash
git clone https://github.com/derek2403/frontier.git
cd frontier
pnpm install
cp .env.example .env
```

Fill in the values in `.env` before continuing, then run:

```bash
./demo.sh
```

The script will derive the EVM address from a Solana PDA, request a
signature, and broadcast a contract call on Sepolia. Verify the
transaction on Etherscan once the script completes.

### Toolchain

This repo uses **pnpm** (10+) as the package manager. Don't run `npm
install` — it will generate a stray `package-lock.json` that conflicts
with `pnpm-lock.yaml`. If you only have npm, install pnpm first:

```bash
npm install -g pnpm
```
