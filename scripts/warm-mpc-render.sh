#!/usr/bin/env bash
#
# Wake the Render MPC committee before a demo.
#
# Render free instances sleep after 15 idle minutes and take about a minute
# to wake. The first signature after a sleep is therefore slow enough to look
# broken on stage. Run this a few minutes before you demo.
#
#   MPC_COORDINATOR_URL=https://soda-mpc-coordinator.onrender.com \
#   MPC_COORDINATOR_TOKEN=<token> \
#   bash scripts/warm-mpc-render.sh
#
# GET /health on the coordinator fans out to both nodes in parallel, so one
# call wakes all three services. With a token set, the script also runs one
# real signature so the JIT is warm too.

set -uo pipefail

URL="${MPC_COORDINATOR_URL:-}"
TOKEN="${MPC_COORDINATOR_TOKEN:-}"

if [[ -z "$URL" ]]; then
  echo "Set MPC_COORDINATOR_URL first." >&2
  exit 1
fi
URL="${URL%/}"

echo "Waking $URL (free instances take up to ~2 min from cold)..."

DEADLINE=$(( $(date +%s) + 240 ))
while :; do
  BODY=$(curl -s --max-time 120 "$URL/health" 2>/dev/null)
  # Both peers report ok only once all three services are running.
  if [[ "$BODY" == *'"p1":{"ok":true'* && "$BODY" == *'"p2":{"ok":true'* ]]; then
    echo "  both nodes awake"
    echo "  $BODY"
    break
  fi
  if (( $(date +%s) > DEADLINE )); then
    echo "  timed out after 4 min. Last response:" >&2
    echo "  ${BODY:-<empty>}" >&2
    exit 1
  fi
  echo "  still waking..."
  sleep 10
done

if [[ -z "$TOKEN" ]]; then
  echo
  echo "No MPC_COORDINATOR_TOKEN set — skipping the warm-up signature."
  echo "The first real sign will pay the JIT cost instead."
  exit 0
fi

echo
echo "Running one warm-up signature..."
T0=$(date +%s)
SIG=$(curl -s --max-time 180 -X POST "$URL/sign" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"payloadHex":"0000000000000000000000000000000000000000000000000000000000000001"}')
T1=$(date +%s)

if [[ "$SIG" == *'"r":'* ]]; then
  echo "  signed in $((T1-T0))s: $SIG"
  echo
  echo "Committee is warm. Demo now — it sleeps again after 15 idle minutes."
else
  echo "  warm-up sign failed: $SIG" >&2
  exit 1
fi
