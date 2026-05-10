# Deploy the SODA MPC stack on AWS

How to host the v0.5 Lindell '17 2-of-2 ECDSA committee on AWS and wire
it into the existing SODA flow. Two paths — pick by how production-y
you want to be.

## Option A: simplest — one EC2 with `docker compose` (~10 min)

All three containers (p1, p2, coordinator) on a single VM. Not a real
multi-operator deployment, but proves the stack runs on AWS and is
enough for a hackathon demo.

### 1. Launch the instance

In the AWS Console → EC2 → Launch Instance:

- **AMI**: Ubuntu Server 22.04 LTS (any region, free tier)
- **Type**: `t3.small` (2 vCPU, 2 GB RAM — plenty for two MPC processes)
- **Storage**: 20 GB gp3
- **Key pair**: pick or create
- **Security group**:
  - Inbound `22/tcp` from your IP (SSH)
  - Inbound `8000/tcp` from `0.0.0.0/0` (coordinator API; tighten to
    your relayer IP for prod)
  - Ports 8001 and 8002 stay closed externally — the coordinator talks
    to them via Docker network only

Or via CLI:

```bash
aws ec2 run-instances \
  --image-id ami-0c02fb55956c7d316 \
  --instance-type t3.small \
  --key-name your-key \
  --security-group-ids sg-xxx \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=soda-mpc}]' \
  --region us-east-1
```

### 2. Install Docker on the host

```bash
ssh ubuntu@<public-ip>

sudo apt update
sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER
exit && ssh ubuntu@<public-ip>   # re-login so docker works without sudo

docker run hello-world           # sanity check
```

### 3. Generate shares locally and ship them up

DKG runs on your laptop once; shares ship to the EC2.

```bash
# On your laptop, in the repo
pnpm mpc:dkg
# writes apps/mpc-node/shares/share-p1.json + share-p2.json
# also prints group_pk.x / group_pk.y — save these for step 5
```

Copy to the EC2:

```bash
ssh ubuntu@<ip> 'mkdir -p ~/frontier/apps/mpc-node/shares'
scp apps/mpc-node/shares/share-p1.json ubuntu@<ip>:~/frontier/apps/mpc-node/shares/
scp apps/mpc-node/shares/share-p2.json ubuntu@<ip>:~/frontier/apps/mpc-node/shares/
```

Then **delete from your laptop** so the orchestrator never has both
shares simultaneously:

```bash
shred -u apps/mpc-node/shares/share-p1.json
shred -u apps/mpc-node/shares/share-p2.json
```

### 4. Clone the repo on the EC2 and start the stack

```bash
ssh ubuntu@<ip>

# Stash the shares while we clone
mv ~/frontier/apps/mpc-node/shares/* /tmp/
rm -rf ~/frontier
git clone https://github.com/derek2403/frontier
cd frontier
mkdir -p apps/mpc-node/shares
mv /tmp/share-p*.json apps/mpc-node/shares/

# Start the three containers
docker compose -f docker-compose.mpc.yml up -d --build

# Verify
docker compose -f docker-compose.mpc.yml ps
docker compose -f docker-compose.mpc.yml logs -f mpc-coordinator
```

The first build takes 2-3 min (pnpm install in the image). Restarts after
that take seconds.

### 5. Update the on-chain `group_pk`

The on-chain `Committee` PDA was initialized with the **v0** single-key
`group_pk`. To make MPC signatures recover correctly under
`secp256k1_recover`, the on-chain key must match the joint MPC key.

If the soda program on devnet doesn't yet have the new
`update_committee` ix, deploy first:

```bash
# On your laptop
cd contracts
anchor build
anchor deploy --provider.cluster devnet
cd ..
```

Then submit the migration ix using the wallet that originally called
`init_committee` (it must equal `Committee.authority`):

```bash
# Run from anywhere with the share file present.
# Easiest: temporarily restore share-p1.json on your laptop, run, then
# `shred -u` again. Or run from the EC2 (it has both shares anyway).

ANCHOR_WALLET=~/.config/solana/id.json \
SOLANA_DEVNET_RPC_URL=<your-devnet-rpc> \
pnpm mpc:update-committee
```

### 6. Smoke test the public coordinator

From your laptop:

```bash
# Health: returns both nodes' /health responses including group_pk
curl http://<ec2-public-ip>:8000/health

# Sign: drives the full 4-message protocol on the AWS docker network
curl -X POST http://<ec2-public-ip>:8000/sign \
  -H 'content-type: application/json' \
  -d '{"payloadHex": "0000000000000000000000000000000000000000000000000000000000000001"}'
# returns { r, s, v }
```

Latency reference (informational):
- localhost ↔ same-host docker: 50-100 ms per signature
- laptop ↔ AWS coordinator (on-host docker): 300-600 ms per signature
- cross-region (Option B): 600 ms - 1.5 s per signature

### 7. Run the demo through the AWS coordinator

```bash
# On your laptop, point the subscriber at the AWS coordinator
MPC_COORDINATOR_URL=http://<ec2-public-ip>:8000 pnpm mpc:subscribe

# In another terminal, kick off the demo
./demo.sh
```

The flow:

```
./demo.sh (laptop)
   │
   ▼
Solana devnet — SigRequested fires
   │
   ▼
mpc-subscriber (laptop) — picks up the event, derives tweak
   │ POST http://<ec2>:8000/sign
   ▼
mpc-coordinator (AWS docker)
   │ HTTP to localhost:8001 / :8002 (docker network)
   ▼
mpc-node-p1, mpc-node-p2 (AWS docker) — run the 4-message protocol
   │
   ▼
{ r, s, v } back to subscriber
   │ submits soda::finalize_signature
   ▼
on-chain secp256k1_recover verifies, SigCompleted fires
```

---

## Option B: production-shape — two EC2s in different regions

If you want to truthfully say "the two nodes are separated geographically
and operationally":

| Component | Location | Open ports | Holds |
| --- | --- | --- | --- |
| `mpc-node-p1` | us-east-1, `t3.small` | 8001 from coordinator IP only | share P1 |
| `mpc-node-p2` | eu-west-1, `t3.small` | 8002 from coordinator IP only | share P2 |
| `mpc-coordinator` | wherever your relayer runs | 8000 from your services | nothing — only forwards bytes |

Each EC2 runs only its own container (the docker-compose isn't right for
this — use `docker run` directly):

### On the P1 host

```bash
git clone https://github.com/derek2403/frontier
cd frontier
mkdir -p apps/mpc-node/shares
# scp share-p1.json from your laptop to apps/mpc-node/shares/
docker build -f apps/mpc-node/Dockerfile -t soda-mpc-node .
docker run -d --restart unless-stopped \
  --name mpc-node-p1 \
  -e MPC_ROLE=p1 \
  -e MPC_SHARE_PATH=/data/share-p1.json \
  -e PORT=8001 \
  -v $(pwd)/apps/mpc-node/shares:/data:ro \
  -p 8001:8001 \
  soda-mpc-node
```

### On the P2 host

Same recipe, but `MPC_ROLE=p2`, `MPC_SHARE_PATH=/data/share-p2.json`,
`PORT=8002`, and copy `share-p2.json` (not p1) into `apps/mpc-node/shares`.

### On the coordinator host

```bash
docker build -f apps/mpc-coordinator/Dockerfile -t soda-mpc-coordinator .
docker run -d --restart unless-stopped \
  --name mpc-coordinator \
  -e MPC_NODE_P1_URL=https://p1.your-domain.com:8001 \
  -e MPC_NODE_P2_URL=https://p2.your-domain.com:8002 \
  -e PORT=8000 \
  -p 8000:8000 \
  soda-mpc-coordinator
```

Use Caddy / Nginx + Let's Encrypt to terminate HTTPS in front of each
node. Or skip TLS for the demo, but lock the node security groups so only
the coordinator IP can reach 8001 / 8002.

---

## Configuration reference

### `mpc-node` env vars

| Env var | Default | Notes |
| --- | --- | --- |
| `MPC_ROLE` | `p1` | Either `p1` or `p2`. Must match the share file's `role` field. |
| `MPC_SHARE_PATH` | `/data/share-p1.json` | Where the JSON share lives inside the container. |
| `PORT` | `8001` for p1, `8002` for p2 | HTTP listen port. Each peer needs its own. |

### `mpc-coordinator` env vars

| Env var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8000` | Coordinator API port. |
| `MPC_NODE_P1_URL` | `http://localhost:8001` | Where P1 lives. Use HTTPS in production. |
| `MPC_NODE_P2_URL` | `http://localhost:8002` | Where P2 lives. |
| `MPC_PEER_TIMEOUT_MS` | `60000` | undici connect / body / headers timeout when talking to peers. Bump if cross-region adds latency. |

### `mpc-subscriber` env vars

| Env var | Default | Notes |
| --- | --- | --- |
| `SOLANA_RPC_URL` | falls back to devnet | RPC for log subscription + ix submission. |
| `MPC_COORDINATOR_URL` | `http://localhost:8000` | Where the coordinator lives (your AWS host). |
| `ANCHOR_WALLET` | `~/.config/solana/id.json` | Pays for `finalize_signature` txs. |

---

## What to tighten before any real deployment

1. **HTTPS in front of every container.** Caddy is the cleanest:
   ```caddyfile
   p1.your-domain.com {
     reverse_proxy localhost:8001
   }
   ```
2. **Auth between coordinator and nodes.** Today it's open HTTP. Add a
   `Authorization: Bearer $TOKEN` check in `mpc-node/src/server.ts` and
   set the same env var on the coordinator. Two lines of code each side.
3. **Encrypted shares at rest.** Wrap `share-p*.json` with `aws kms
   encrypt` before scp; decrypt at container startup using the EC2's
   instance-profile KMS access. Or use Nitro Enclaves and never let
   plaintext shares touch the EBS volume.
4. **Restart on host reboot.** `docker run --restart unless-stopped`
   covers crashes but not host reboots — wrap in a `systemd` unit if you
   need that.
5. **Logs to CloudWatch.** Each container is plain stdout, so
   `--log-driver=awslogs` is one-liner.

---

## Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Connect Timeout Error` from coordinator | Tunneled / cold-start node, default 10 s timeout too tight | Bump `MPC_PEER_TIMEOUT_MS` (default is now 60 s, was 10 s before fix) |
| `408 Request Timeout` from `loca.lt` / similar tunnel | Free tunnel agent died | Restart `lt` / use real DNS / use proper EC2 |
| `EADDRINUSE :3001` | A previous dev process didn't shut down | `kill $(lsof -ti:3001)` |
| `foreign_pk mismatch — refusing to sign` | Subscriber's local `group_pk` doesn't match what's on-chain | Run `pnpm mpc:update-committee` after DKG |
| `AlreadyCompleted` (custom error 0x1770) | Some other process already finalized | Idempotent — treat as success |

---

## Tear-down

```bash
ssh ubuntu@<ip>
cd frontier
docker compose -f docker-compose.mpc.yml down
exit

# When done with the demo:
aws ec2 terminate-instances --instance-ids i-xxxxxxxxxxxxxxxxx
```

Don't forget the security group — `aws ec2 delete-security-group --group-id sg-xxx`.
