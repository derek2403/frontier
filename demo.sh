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
#   ./demo.sh                                — default: devnet, self-transfer
#   DEMO_RECIPIENT=0x… ./demo.sh             — send to a specific address
#   SODA_DRY_RUN=1 ./demo.sh                 — skip Sepolia broadcast
#   SOLANA_CLUSTER=local ./demo.sh           — run against local validator
#
# Optional env: SEPOLIA_RPC_URL, ANCHOR_WALLET, SOLANA_RPC_URL.

set -euo pipefail
cd "$(dirname "$0")"

# Load .env (gitignored) for SEPOLIA_RPC_URL etc.
if [[ -f .env ]]; then
    set -a; . ./.env; set +a
fi

CLUSTER="${SOLANA_CLUSTER:-devnet}"
case "$CLUSTER" in
    local)
        RPC_URL="http://127.0.0.1:8899"
        EXPLORER_BASE=""
        ;;
    devnet)
        # Prefer the Helius URL from .env (faster + no public-RPC rate limits
        # on reads/writes). Public api.devnet.solana.com is the fallback.
        RPC_URL="${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}"
        EXPLORER_BASE="https://solscan.io"
        ;;
    mainnet)
        RPC_URL="https://api.mainnet-beta.solana.com"
        EXPLORER_BASE="https://solscan.io"
        ;;
    *)
        echo "Unknown SOLANA_CLUSTER='$CLUSTER' (expected: local | devnet | mainnet)"
        exit 1
        ;;
esac
export SOLANA_RPC_URL="$RPC_URL"

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

# 2. Wallet balance
step "Checking Solana wallet balance..."
BAL_SOL_RAW=$(solana balance --url "$RPC_URL" 2>/dev/null | awk '{print $1}')
BAL_SOL_INT=${BAL_SOL_RAW%%.*}
if [[ "${BAL_SOL_INT:-0}" -lt 5 ]]; then
    if [[ "$CLUSTER" == "local" ]]; then
        warn "balance ${BAL_SOL_RAW:-0} SOL — airdropping 100"
        solana airdrop 100 --url "$RPC_URL" >/dev/null 2>&1 || warn "airdrop failed; continuing"
    else
        WALLET_ADDR=$(solana address)
        warn "balance ${BAL_SOL_RAW:-0} SOL — airdrop is rate-limited on $CLUSTER."
        warn "Fund the wallet manually:"
        warn "  wallet:  $WALLET_ADDR"
        warn "  faucet:  https://faucet.solana.com"
        warn "  needed:  ~10 SOL (if programs aren't deployed yet) or ~0.1 SOL (if they are)"
        warn "Re-run this script once the balance is at least 5 SOL."
        fail "insufficient balance"
    fi
fi
ok "wallet $(solana address) has $(solana balance --url "$RPC_URL")"

# 3. Deploy programs if not on-chain
SODA_ID=$(awk -F\" '/^soda /{print $2}' contracts/Anchor.toml)
ETH_DEMO_ID=$(awk -F\" '/^eth_demo /{print $2}' contracts/Anchor.toml)

needs_deploy=0
if ! solana program show "$SODA_ID" --url "$RPC_URL" >/dev/null 2>&1; then needs_deploy=1; fi
if ! solana program show "$ETH_DEMO_ID" --url "$RPC_URL" >/dev/null 2>&1; then needs_deploy=1; fi

if [[ "$needs_deploy" -eq 1 ]]; then
    step "Programs missing on $CLUSTER — running anchor deploy..."
    if [[ ! -f contracts/target/deploy/soda.so ]]; then
        ( cd contracts && anchor build )
    fi
    if [[ "$CLUSTER" == "local" ]]; then
        ( cd contracts && anchor deploy ) | tail -5
    else
        # Anchor's --provider.cluster takes a cluster name or URL.
        ( cd contracts && anchor deploy --provider.cluster "$RPC_URL" ) | tail -5
    fi
fi
ok "soda     deployed at $SODA_ID${EXPLORER_BASE:+  ($EXPLORER_BASE/account/$SODA_ID${CLUSTER:+?cluster=$CLUSTER})}"
ok "eth_demo deployed at $ETH_DEMO_ID${EXPLORER_BASE:+  ($EXPLORER_BASE/account/$ETH_DEMO_ID${CLUSTER:+?cluster=$CLUSTER})}"

# 4. Run the demo
step "Running demo..."
rm -f .last-tx-hash
pnpm demo

# 5. If the demo broadcast a real ETH tx, run the verify pass on it.
if [[ -f .last-tx-hash ]]; then
    LAST_TX=$(cat .last-tx-hash)
    if [[ -n "$LAST_TX" ]]; then
        step "Running cryptographic audit on ${LAST_TX:0:18}…"
        pnpm verify "$LAST_TX"
    fi
fi
