#!/usr/bin/env bash
# End-to-end proof that the MPC committee signs for a SODA-derived address,
# with the real on-chain program as the judge.
#
# Starts a local validator with the soda program loaded at its declared
# address, runs both MPC nodes and the coordinator against it, then drives
# one full request -> MPC sign -> finalize_signature cycle.
#
#   bash scripts/mpc-e2e-local.sh
#
# Everything it starts, it stops. Nothing here touches devnet.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

SODA_PROGRAM_ID="${SODA_PROGRAM_ID:-$(python3 -c "import json;print(json.load(open('contracts/target/idl/soda.json'))['address'])")}"
SO="contracts/target/deploy/soda.so"
LEDGER="${LEDGER:-/tmp/soda-e2e-ledger}"
LOGS="${LOGS:-/tmp/soda-e2e-logs}"

[ -f "$SO" ] || { echo "Missing $SO — run 'cd contracts && anchor build'"; exit 1; }
for f in share-p1 share-p2; do
  [ -f "apps/mpc-node/shares/$f.json" ] || { echo "Missing apps/mpc-node/shares/$f.json — run 'pnpm mpc:dkg'"; exit 1; }
done

mkdir -p "$LOGS"
rm -rf "$LEDGER"

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo "==> local validator (soda at $SODA_PROGRAM_ID)"
# The default dynamic port range is 8000-8020, which collides with the
# coordinator on 8000. Move it rather than move the services.
solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --dynamic-port-range 9100-9130 \
  --bpf-program "$SODA_PROGRAM_ID" "$SO" > "$LOGS/validator.log" 2>&1 &
pids+=($!)

until solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; do sleep 2; done
solana airdrop 100 --url http://127.0.0.1:8899 >/dev/null 2>&1 || true
echo "    up"

export SOLANA_RPC_URL=http://127.0.0.1:8899
export SODA_PROGRAM_ID

echo "==> MPC committee (p1, p2, coordinator)"
MPC_ROLE=p1 PORT=8001 MPC_SHARE_PATH="$REPO/apps/mpc-node/shares/share-p1.json" \
  pnpm --filter mpc-node dev > "$LOGS/p1.log" 2>&1 &
pids+=($!)
MPC_ROLE=p2 PORT=8002 MPC_SHARE_PATH="$REPO/apps/mpc-node/shares/share-p2.json" \
  pnpm --filter mpc-node dev > "$LOGS/p2.log" 2>&1 &
pids+=($!)
PORT=8000 MPC_NODE_P1_URL=http://127.0.0.1:8001 MPC_NODE_P2_URL=http://127.0.0.1:8002 \
  pnpm --filter mpc-coordinator dev > "$LOGS/coord.log" 2>&1 &
pids+=($!)

until curl -sf --max-time 20 http://127.0.0.1:8000/health 2>/dev/null | grep -q '"ok":true'; do sleep 2; done
echo "    both peers reachable, same group_pk"

echo "==> end to end"
MPC_COORDINATOR_URL=http://127.0.0.1:8000 \
  pnpm --filter mpc-node exec tsx scripts/e2e-mpc.ts
