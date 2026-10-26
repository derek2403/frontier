#!/usr/bin/env bash
# Starts our local Alpenglow network for the /alpenglow page:
#   solana-test-validator --alpenglow (Agave 4.3.2, the version mainnet runs)
#   + Yellowstone gRPC v16.1.5 on 127.0.0.1:10000, which streams block footers
#     with their real finality certificates.
#
# Usage: ./start-local-node.sh          keep the ledger (same validator keys)
#        ./start-local-node.sh --reset  start a fresh chain
#
# The binaries live in node/ (git-ignored). To rebuild them:
#   Agave:  https://github.com/anza-xyz/agave/releases/tag/v4.3.2
#           (solana-release-aarch64-apple-darwin.tar.bz2; needs `brew install libusb`)
#   plugin: git clone --branch "v16.1.5+solana.4.3.2" https://github.com/rpcpool/yellowstone-grpc
#           cargo build --release -p yellowstone-grpc-geyser
set -euo pipefail
cd "$(dirname "$0")/node"
HERE="$(pwd)"

cat > yellowstone.json <<EOF
{
  "libpath": "$HERE/libyellowstone_grpc_geyser.dylib",
  "log": { "level": "info" },
  "grpc": { "address": "127.0.0.1:10000", "channel_capacity": "100_000", "unary_concurrency_limit": 100, "unary_disabled": false }
}
EOF

exec ./agave-4.3.2/bin/solana-test-validator \
  --alpenglow \
  --geyser-plugin-config "$HERE/yellowstone.json" \
  --ledger "$HERE/ledger" \
  "$@"
