#!/usr/bin/env bash
# SODA one-shot demo. Picks the Solana cluster from $SOLANA_CLUSTER:
#
#   SOLANA_CLUSTER=devnet  (default) — Solana devnet, Solscan-visible.
#                                      Wallet must already have SOL (faucet
#                                      manually if needed: https://faucet.solana.com).
#                                      Programs persist between runs.
#   SOLANA_CLUSTER=local             — local solana-test-validator, free SOL.
#                                      Auto-starts validator + airdrops.
#
# Other usage:
#   ./demo.sh                                — default: devnet, Aave depositETH
#   DEMO_ACTION=borrow ./demo.sh             — Aave Pool.borrow 0.1 USDC against the aWETH
#   DEMO_CHAIN=base-sepolia ./demo.sh        — destination chain (sepolia | base-sepolia)
#   DEMO_CHAIN=sui-testnet ./demo.sh         — Sui: 0.001 SUI transfer from the derived
#                                              Sui address (sui-testnet | sui-devnet)
#   SODA_DRY_RUN=1 ./demo.sh                 — skip the foreign-chain broadcast
#   SOLANA_CLUSTER=local ./demo.sh           — run against local validator
#
# Optional env: SEPOLIA_RPC_URL / BASE_SEPOLIA_RPC_URL, SEPOLIA_FUNDER_KEY,
# SUI_FUNDER_KEY, SUI_TESTNET_GRAPHQL_URL, ANCHOR_WALLET, SOLANA_RPC_URL.

set -euo pipefail
cd "$(dirname "$0")"

# Load .env (gitignored) for SEPOLIA_RPC_URL etc. Anything already set in the
# environment wins: `DEMO_CHAIN=sui-testnet ./demo.sh` used to be silently
# overridden by the DEMO_CHAIN line in .env and run the EVM demo instead.
#
# Only the keys .env actually defines are snapshotted and put back. Replaying
# a whole `export -p` also replays readonly variables — a shell that exports
# SHELLOPTS makes `declare` fail, and under `set -e` that ends the run before
# the first step.
if [[ -f .env ]]; then
    _env_keys=$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' .env)
    _env_restore=""
    for _k in $_env_keys; do
        if [[ -n "${!_k+set}" ]]; then
            _env_restore="$_env_restore$(declare -p "$_k" 2>/dev/null)
"
        fi
    done
    set -a; . ./.env; set +a
    eval "$_env_restore" 2>/dev/null || true
    unset _env_keys _env_restore _k
fi

CLUSTER="${SOLANA_CLUSTER:-devnet}"
case "$CLUSTER" in
    local)
        RPC_URL="http://127.0.0.1:8899"
        WS_URL="ws://127.0.0.1:8900"
        EXPLORER_BASE=""
        ;;
    devnet)
        # Prefer the Helius URL from .env (faster + no public-RPC rate limits
        # on reads/writes). Public api.devnet.solana.com is the fallback.
        RPC_URL="${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}"
        # Subscriptions go to the public node even when RPC_URL is a provider:
        # web3.js confirms via signatureSubscribe over WS, and Alchemy's Solana
        # endpoint answers that with -32601 Method not found. HTTP stays on the
        # provider; only the socket falls back.
        WS_URL="${SOLANA_WS_URL:-wss://api.devnet.solana.com}"
        EXPLORER_BASE="https://solscan.io"
        ;;
    mainnet)
        RPC_URL="https://api.mainnet-beta.solana.com"
        WS_URL="${SOLANA_WS_URL:-wss://api.mainnet-beta.solana.com}"
        EXPLORER_BASE="https://solscan.io"
        ;;
    *)
        echo "Unknown SOLANA_CLUSTER='$CLUSTER' (expected: local | devnet | mainnet)"
        exit 1
        ;;
esac
export SOLANA_RPC_URL="$RPC_URL"
export SOLANA_WS_URL="$WS_URL"

VALIDATOR_LOG="/tmp/soda-validator.log"

step() { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m! %s\033[0m\n" "$*"; }
fail() { printf "\033[1;31m✗ %s\033[0m\n" "$*"; exit 1; }

step "Cluster: $CLUSTER ($RPC_URL)"

# 1. Validator (local only)
if [[ "$CLUSTER" == "local" ]]; then
    if ! solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then
        warn "validator not running — starting in background (logs: $VALIDATOR_LOG)"
        nohup solana-test-validator --reset --quiet >"$VALIDATOR_LOG" 2>&1 &
        for _ in $(seq 1 30); do
            sleep 2
            if solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then break; fi
        done
        if ! solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then
            fail "validator failed to start. See $VALIDATOR_LOG."
        fi
    fi
    ok "validator up: $(solana cluster-version --url "$RPC_URL")"
else
    if ! solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then
        fail "cluster $CLUSTER unreachable at $RPC_URL"
    fi
    ok "cluster reachable: $(solana cluster-version --url "$RPC_URL")"
fi

solana config set --url "$RPC_URL" >/dev/null

# 2. Which chain family? sui-* keys run the Sui demo program; everything
# else is EVM. Decides which caller program must be deployed and which
# demo / verify scripts run.
case "${DEMO_CHAIN:-sepolia}" in
    sui-*) FAMILY="sui";  DEMO_SCRIPT="demo:sui"; VERIFY_SCRIPT="verify:sui"; CALLER="sui_demo" ;;
    *)     FAMILY="evm";  DEMO_SCRIPT="demo";     VERIFY_SCRIPT="verify";     CALLER="eth_demo" ;;
esac
step "Destination: ${DEMO_CHAIN:-sepolia} ($FAMILY → $CALLER)"

# 3. Are the programs on-chain? Decides how much SOL the wallet needs.
SODA_ID=$(awk -F\" '/^soda /{print $2}' contracts/Anchor.toml)
CALLER_ID=$(awk -F\" -v p="^$CALLER " '$0 ~ p {print $2}' contracts/Anchor.toml)

# Only the programs that are actually missing get deployed: `anchor deploy`
# with no --program-name re-uploads every program in the workspace, which
# on devnet means paying to upgrade soda and eth_demo just to add sui_demo.
needs_deploy=0
DEPLOY_LIST=()
if ! solana program show "$SODA_ID" --url "$RPC_URL" >/dev/null 2>&1; then needs_deploy=1; DEPLOY_LIST+=("soda"); fi
if ! solana program show "$CALLER_ID" --url "$RPC_URL" >/dev/null 2>&1; then needs_deploy=1; DEPLOY_LIST+=("$CALLER"); fi

# 4. Wallet balance. A deploy needs ~5 SOL of rent; a demo run costs a few
# thousand lamports. The gate used to demand 5 SOL unconditionally, which
# refused to run a demo on a wallet holding 4.99 SOL with everything deployed.
step "Checking Solana wallet balance..."
BAL_SOL_RAW=$(solana balance --url "$RPC_URL" 2>/dev/null | awk '{print $1}')
BAL_LAMPORTS=$(awk -v b="${BAL_SOL_RAW:-0}" 'BEGIN{printf "%d", b*1000000000}')
if [[ "$needs_deploy" -eq 1 ]]; then MIN_LAMPORTS=5000000000; else MIN_LAMPORTS=50000000; fi
if [[ "$BAL_LAMPORTS" -lt "$MIN_LAMPORTS" ]]; then
    if [[ "$CLUSTER" == "local" ]]; then
        warn "balance ${BAL_SOL_RAW:-0} SOL — airdropping 100"
        solana airdrop 100 --url "$RPC_URL" >/dev/null 2>&1 || warn "airdrop failed; continuing"
    else
        WALLET_ADDR=$(solana address)
        warn "balance ${BAL_SOL_RAW:-0} SOL — airdrop is rate-limited on $CLUSTER."
        warn "Fund the wallet manually:"
        warn "  wallet:  $WALLET_ADDR"
        warn "  faucet:  https://faucet.solana.com"
        if [[ "$needs_deploy" -eq 1 ]]; then
            warn "  needed:  ~5 SOL (programs are not deployed yet)"
        else
            warn "  needed:  ~0.05 SOL (programs are deployed; a run costs a few thousand lamports)"
        fi
        fail "insufficient balance"
    fi
fi
ok "wallet $(solana address) has $(solana balance --url "$RPC_URL")"

# 5. Deploy programs if not on-chain

if [[ "$needs_deploy" -eq 1 ]]; then
    step "Programs missing on $CLUSTER (${DEPLOY_LIST[*]}) — running anchor deploy..."
    if [[ ! -f "contracts/target/deploy/$CALLER.so" || ! -f contracts/target/deploy/soda.so ]]; then
        ( cd contracts && anchor build )
    fi
    for prog in "${DEPLOY_LIST[@]}"; do
        if [[ "$CLUSTER" == "local" ]]; then
            ( cd contracts && anchor deploy --program-name "$prog" ) | tail -5
        else
            # Anchor's --provider.cluster takes a cluster name or URL.
            ( cd contracts && anchor deploy --program-name "$prog" --provider.cluster "$RPC_URL" ) | tail -5
        fi
    done
fi
ok "soda     deployed at $SODA_ID${EXPLORER_BASE:+  ($EXPLORER_BASE/account/$SODA_ID${CLUSTER:+?cluster=$CLUSTER})}"
ok "$CALLER deployed at $CALLER_ID${EXPLORER_BASE:+  ($EXPLORER_BASE/account/$CALLER_ID${CLUSTER:+?cluster=$CLUSTER})}"

# 6. Run the demo
step "Running demo..."
rm -f .last-tx-hash
pnpm "$DEMO_SCRIPT"

# 7. If the demo broadcast a real foreign-chain tx, run the verify pass on it.
if [[ -f .last-tx-hash ]]; then
    LAST_TX=$(cat .last-tx-hash)
    if [[ -n "$LAST_TX" ]]; then
        step "Running cryptographic audit on ${LAST_TX:0:18}…"
        pnpm "$VERIFY_SCRIPT" "$LAST_TX"
    fi
fi
