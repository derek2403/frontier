#!/usr/bin/env bash
# deploy-mpc-aws.sh — provisions all 3 SODA MPC EC2 instances from your laptop.
#
# Run from the frontier repo root:
#   bash scripts/deploy-mpc-aws.sh
#
# Prerequisites:
#   1. Three t3.small EC2 instances running (Amazon Linux 2023).
#   2. PEM files in ~/Downloads.
#   3. Local DKG already run: apps/mpc-node/shares/share-p1.json + share-p2.json exist.
#   4. Security groups allow:
#        - SSH (22) from your IP on all 3 hosts
#        - Coord public IP can reach 8001 on p1 and 8002 on p2 (or simpler: same SG / default)
#        - 8000 on coordinator reachable from your laptop

set -euo pipefail

# ─── CONFIG ────────────────────────────────────────────────────────────────
P1_IP=44.201.168.181
P2_IP=54.88.35.104
COORD_IP=32.198.7.34

P1_PRIVATE=172.31.94.167
P2_PRIVATE=172.31.92.69

SSH_USER=ec2-user
REPO=https://github.com/derek2403/frontier.git

PEM_P1="$HOME/Downloads/soda-mpc-node-p1.pem"
PEM_P2="$HOME/Downloads/soda-mpc-node-p2.pem"
PEM_COORD="$HOME/Downloads/soda-mpc-coordinator.pem"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

# ─── HELPERS ───────────────────────────────────────────────────────────────
log() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
err() { printf "\n\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

remote() {
  local pem=$1; local host=$2; shift 2
  ssh "${SSH_OPTS[@]}" -i "$pem" "$SSH_USER@$host" "$@"
}

# ─── PRE-FLIGHT ────────────────────────────────────────────────────────────
log "Pre-flight checks"

[[ -f "$PEM_P1" ]]    || err "Missing PEM: $PEM_P1"
[[ -f "$PEM_P2" ]]    || err "Missing PEM: $PEM_P2"
[[ -f "$PEM_COORD" ]] || err "Missing PEM: $PEM_COORD"
chmod 400 "$PEM_P1" "$PEM_P2" "$PEM_COORD"

[[ -f apps/mpc-node/shares/share-p1.json ]] \
  || err "apps/mpc-node/shares/share-p1.json not found. Run 'pnpm mpc:dkg' first."
[[ -f apps/mpc-node/shares/share-p2.json ]] \
  || err "apps/mpc-node/shares/share-p2.json not found. Run 'pnpm mpc:dkg' first."

# ─── 1. INSTALL DOCKER + GIT, CLONE / UPDATE REPO ─────────────────────────
provision() {
  local pem=$1 host=$2 name=$3
  log "[$name] installing docker + (re)cloning repo on $host"
  remote "$pem" "$host" bash -s <<'EOF'
set -e
sudo dnf install -y docker git jq >/dev/null
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
if [[ ! -d frontier ]]; then
  git clone https://github.com/derek2403/frontier.git
else
  cd frontier && git fetch origin && git reset --hard origin/main && cd -
fi
EOF
}

provision "$PEM_P1"    "$P1_IP"    "p1"
provision "$PEM_P2"    "$P2_IP"    "p2"
provision "$PEM_COORD" "$COORD_IP" "coord"

# ─── 1.5. OVERRIDE REPO CONFIG WITH LOCAL FIXES (no git push required) ────
sync_repo_config() {
  local pem=$1 host=$2 name=$3
  log "[$name] syncing local package.json + pnpm-workspace.yaml + pnpm-lock.yaml"
  scp "${SSH_OPTS[@]}" -i "$pem" package.json         "$SSH_USER@$host:/tmp/_pkg.json"
  scp "${SSH_OPTS[@]}" -i "$pem" pnpm-workspace.yaml  "$SSH_USER@$host:/tmp/_pnpm-ws.yaml"
  scp "${SSH_OPTS[@]}" -i "$pem" pnpm-lock.yaml       "$SSH_USER@$host:/tmp/_pnpm-lock.yaml"
  remote "$pem" "$host" "
    mv /tmp/_pkg.json         frontier/package.json
    mv /tmp/_pnpm-ws.yaml     frontier/pnpm-workspace.yaml
    mv /tmp/_pnpm-lock.yaml   frontier/pnpm-lock.yaml
  "
}

sync_repo_config "$PEM_P1"    "$P1_IP"    "p1"
sync_repo_config "$PEM_P2"    "$P2_IP"    "p2"
sync_repo_config "$PEM_COORD" "$COORD_IP" "coord"

# ─── 2. SHIP SHARES TO THE NODE INSTANCES ─────────────────────────────────
log "Copying share-p1.json → p1"
scp "${SSH_OPTS[@]}" -i "$PEM_P1" apps/mpc-node/shares/share-p1.json \
  "$SSH_USER@$P1_IP:/tmp/share-p1.json"
remote "$PEM_P1" "$P1_IP" "
  mkdir -p frontier/apps/mpc-node/shares
  mv /tmp/share-p1.json frontier/apps/mpc-node/shares/
  chmod 600 frontier/apps/mpc-node/shares/share-p1.json
"

log "Copying share-p2.json → p2"
scp "${SSH_OPTS[@]}" -i "$PEM_P2" apps/mpc-node/shares/share-p2.json \
  "$SSH_USER@$P2_IP:/tmp/share-p2.json"
remote "$PEM_P2" "$P2_IP" "
  mkdir -p frontier/apps/mpc-node/shares
  mv /tmp/share-p2.json frontier/apps/mpc-node/shares/
  chmod 600 frontier/apps/mpc-node/shares/share-p2.json
"

# ─── 3. BUILD + RUN EACH CONTAINER ────────────────────────────────────────
log "[p1] building + running mpc-node container"
remote "$PEM_P1" "$P1_IP" bash -s <<'EOF'
set -e
cd frontier
sudo docker build -f apps/mpc-node/Dockerfile -t soda-mpc-node . >/tmp/build.log 2>&1 \
  || (echo "BUILD FAILED, last 30 lines:"; tail -30 /tmp/build.log; exit 1)
sudo docker rm -f mpc-node-p1 2>/dev/null || true
sudo docker run -d --restart unless-stopped \
  --name mpc-node-p1 \
  -e MPC_ROLE=p1 \
  -e MPC_SHARE_PATH=/data/share-p1.json \
  -e PORT=8001 \
  -v "$(pwd)/apps/mpc-node/shares:/data:ro" \
  -p 8001:8001 \
  soda-mpc-node >/dev/null
echo "waiting for p1 to come up..."
for i in $(seq 1 30); do
  if curl -fs http://localhost:8001/health >/dev/null 2>&1; then
    echo "p1 healthy (after ${i}s)"
    break
  fi
  sleep 1
  if [[ "$i" == "30" ]]; then
    echo "p1 NOT healthy after 30s. Last 40 lines of container logs:"
    sudo docker logs mpc-node-p1 2>&1 | tail -40
    exit 1
  fi
done
EOF

log "[p2] building + running mpc-node container"
remote "$PEM_P2" "$P2_IP" bash -s <<'EOF'
set -e
cd frontier
sudo docker build -f apps/mpc-node/Dockerfile -t soda-mpc-node . >/tmp/build.log 2>&1 \
  || (echo "BUILD FAILED, last 30 lines:"; tail -30 /tmp/build.log; exit 1)
sudo docker rm -f mpc-node-p2 2>/dev/null || true
sudo docker run -d --restart unless-stopped \
  --name mpc-node-p2 \
  -e MPC_ROLE=p2 \
  -e MPC_SHARE_PATH=/data/share-p2.json \
  -e PORT=8002 \
  -v "$(pwd)/apps/mpc-node/shares:/data:ro" \
  -p 8002:8002 \
  soda-mpc-node >/dev/null
echo "waiting for p2 to come up..."
for i in $(seq 1 30); do
  if curl -fs http://localhost:8002/health >/dev/null 2>&1; then
    echo "p2 healthy (after ${i}s)"
    break
  fi
  sleep 1
  if [[ "$i" == "30" ]]; then
    echo "p2 NOT healthy after 30s. Last 40 lines of container logs:"
    sudo docker logs mpc-node-p2 2>&1 | tail -40
    exit 1
  fi
done
EOF

log "[coord] building + running mpc-coordinator container"
# Note: heredoc is UNquoted on purpose so $P1_PRIVATE / $P2_PRIVATE expand here.
# Anything that must evaluate on the remote side is escaped with backslashes.
remote "$PEM_COORD" "$COORD_IP" bash -s <<EOF
set -e
cd frontier
sudo docker build -f apps/mpc-coordinator/Dockerfile -t soda-mpc-coordinator . >/tmp/build.log 2>&1 \
  || (echo "BUILD FAILED, last 30 lines:"; tail -30 /tmp/build.log; exit 1)
sudo docker rm -f mpc-coordinator 2>/dev/null || true
sudo docker run -d --restart unless-stopped \
  --name mpc-coordinator \
  -e MPC_NODE_P1_URL=http://$P1_PRIVATE:8001 \
  -e MPC_NODE_P2_URL=http://$P2_PRIVATE:8002 \
  -e MPC_PEER_TIMEOUT_MS=60000 \
  -e PORT=8000 \
  -p 8000:8000 \
  soda-mpc-coordinator >/dev/null
echo "waiting for coordinator to come up..."
for i in \$(seq 1 30); do
  if curl -fs http://localhost:8000/health >/dev/null 2>&1; then
    echo "coordinator healthy (after \${i}s)"
    break
  fi
  sleep 1
  if [[ "\$i" == "30" ]]; then
    echo "coordinator NOT healthy after 30s. Last 40 lines of container logs:"
    sudo docker logs mpc-coordinator 2>&1 | tail -40
    exit 1
  fi
done
EOF

# ─── 4. SUMMARY ───────────────────────────────────────────────────────────
log "All three services deployed."

cat <<EOM

Next steps (run on your laptop):

  # 1. Confirm the coordinator sees both peers
  curl http://$COORD_IP:8000/health

  # 2. Real signature test
  curl -X POST http://$COORD_IP:8000/sign \\
    -H 'content-type: application/json' \\
    -d '{"payloadHex":"0000000000000000000000000000000000000000000000000000000000000001"}'

  # 3. Point the subscriber at AWS and run the demo
  MPC_COORDINATOR_URL=http://$COORD_IP:8000 pnpm mpc:subscribe
  ./demo.sh

If curl from your laptop hangs, open inbound TCP 8000 on the coordinator's
security group (from your IP, or 0.0.0.0/0 for the hackathon demo).

If the coordinator's /health shows the peers as unreachable, open inbound
TCP 8001 on p1's security group and 8002 on p2's security group, with the
source set to the coordinator's private IP ($P1_PRIVATE / $P2_PRIVATE see
the coordinator at 172.31.89.14 — or just use the same SG for all 3).

EOM
