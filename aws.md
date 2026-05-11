# Deploy the SODA MPC stack on AWS

How to host the v0.5 Lindell '17 2-of-2 ECDSA committee on AWS. The
right deployment is **three separate EC2 instances** — one per MPC node
plus one coordinator. Co-locating the two shares on one box would mean
a single root user can read both `share-p1.json` and `share-p2.json`,
which is precisely what MPC is supposed to prevent.

## Topology

```
                       mpc-coordinator EC2
                       (any region; port 8000 open to your services)
                                │
                        ┌───────┴───────┐
                        ▼               ▼
                 mpc-node-p1 EC2   mpc-node-p2 EC2
                 (region A,        (region B,
                  port 8001 open    port 8002 open
                  to coordinator)   to coordinator)
                 holds share P1     holds share P2
```

Same region is acceptable for a hackathon demo (different AZs is nice).
Different regions is strongly recommended for any "two operators in
different failure domains" claim.

## Cost reference

| Instance | Type | Region | ~Monthly cost |
| --- | --- | --- | --- |
| `mpc-node-p1` | `t3.small` | us-east-1 | ~$15 |
| `mpc-node-p2` | `t3.small` | eu-west-1 | ~$16 |
| `mpc-coordinator` | `t3.small` | wherever your relayer runs | ~$15 |
| **Total** | | | **~$46/mo** |

`t3.micro` (free-tier) works too but only has 1 GB RAM; the Paillier
crypto operations during signing peak around 200 MB so it's tight.

---

## Step 1 — Generate the shares on your laptop (one-time)

DKG happens locally. The output is two share files plus the joint
`group_pk` you'll need on-chain.

```bash
# In the repo on your laptop
pnpm mpc:dkg

# Console output:
#   group_pk.x = 24732a17...
#   group_pk.y = 40739444...
#   share-a    → apps/mpc-node/shares/share-p1.json
#   share-b    → apps/mpc-node/shares/share-p2.json
```

Save the `group_pk.x` / `group_pk.y` values — you'll need them in Step
5 when migrating the on-chain `Committee` PDA.

**Important:** at this moment your laptop has both shares. Get them off
your laptop as soon as you've shipped them to AWS (Step 3). Never keep
both shares in one place after deployment.

---

## Step 2 — Launch three EC2 instances

### Node P1 (region A, e.g. us-east-1)

Console → EC2 → Launch Instance:

- **Name**: `soda-mpc-node-p1`
- **AMI**: Ubuntu Server 22.04 LTS
- **Type**: `t3.small`
- **Storage**: 20 GB gp3
- **Key pair**: pick or create
- **Security group** (`soda-mpc-p1-sg`):
  - Inbound `22/tcp` from your IP (SSH)
  - Inbound `8001/tcp` from the **coordinator EC2's public IP** (or its
    Elastic IP), not from `0.0.0.0/0`

CLI equivalent:

```bash
aws ec2 run-instances \
  --region us-east-1 \
  --image-id ami-0c02fb55956c7d316 \
  --instance-type t3.small \
  --key-name your-key \
  --security-group-ids sg-p1xxx \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=soda-mpc-node-p1}]'
```

### Node P2 (region B, e.g. eu-west-1)

Same recipe, change region + name:

- **Name**: `soda-mpc-node-p2`
- **Security group** (`soda-mpc-p2-sg`):
  - Inbound `22/tcp` from your IP
  - Inbound `8002/tcp` from coordinator's IP

```bash
aws ec2 run-instances \
  --region eu-west-1 \
  --image-id ami-093cb9fb2d34920ad \
  --instance-type t3.small \
  --key-name your-key \
  --security-group-ids sg-p2xxx \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=soda-mpc-node-p2}]'
```

### Coordinator (any region, ideally where your relayer / dApp backend lives)

- **Name**: `soda-mpc-coordinator`
- **Security group** (`soda-mpc-coord-sg`):
  - Inbound `22/tcp` from your IP
  - Inbound `8000/tcp` from your services (relayer / web backend / dev
    machine). Open to `0.0.0.0/0` only for the hackathon demo.

```bash
aws ec2 run-instances \
  --region us-east-1 \
  --image-id ami-0c02fb55956c7d316 \
  --instance-type t3.small \
  --key-name your-key \
  --security-group-ids sg-coordxxx \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=soda-mpc-coordinator}]'
```

You now have three public IPs. Call them `P1_IP`, `P2_IP`, `COORD_IP`
for the rest of this guide.

---

## Step 3 — Ship the share files

```bash
# From your laptop
ssh ubuntu@$P1_IP 'mkdir -p ~/shares'
ssh ubuntu@$P2_IP 'mkdir -p ~/shares'

scp apps/mpc-node/shares/share-p1.json ubuntu@$P1_IP:~/shares/share-p1.json
scp apps/mpc-node/shares/share-p2.json ubuntu@$P2_IP:~/shares/share-p2.json

# Sanity: confirm the right file landed on the right host
ssh ubuntu@$P1_IP 'jq .role ~/shares/share-p1.json'   # "p1"
ssh ubuntu@$P2_IP 'jq .role ~/shares/share-p2.json'   # "p2"

# Now wipe your local copies — your laptop must not hold both shares
shred -u apps/mpc-node/shares/share-p1.json
shred -u apps/mpc-node/shares/share-p2.json
```

---

## Step 4 — Install Docker and run the container on each EC2

Do this **on all three hosts**. The base setup is identical; the
container command differs.

```bash
ssh ubuntu@<host>

sudo apt update
sudo apt install -y docker.io docker-compose-plugin git jq
sudo usermod -aG docker $USER
exit && ssh ubuntu@<host>      # re-login so docker works without sudo

git clone https://github.com/derek2403/frontier
cd frontier
```

Now the host-specific container commands:

### On Node P1

```bash
mkdir -p apps/mpc-node/shares
mv ~/shares/share-p1.json apps/mpc-node/shares/

docker build -f apps/mpc-node/Dockerfile -t soda-mpc-node .

docker run -d --restart unless-stopped \
  --name mpc-node-p1 \
  -e MPC_ROLE=p1 \
  -e MPC_SHARE_PATH=/data/share-p1.json \
  -e PORT=8001 \
  -v $(pwd)/apps/mpc-node/shares:/data:ro \
  -p 8001:8001 \
  soda-mpc-node

# Verify
curl http://localhost:8001/health
```

### On Node P2

```bash
mkdir -p apps/mpc-node/shares
mv ~/shares/share-p2.json apps/mpc-node/shares/

docker build -f apps/mpc-node/Dockerfile -t soda-mpc-node .

docker run -d --restart unless-stopped \
  --name mpc-node-p2 \
  -e MPC_ROLE=p2 \
  -e MPC_SHARE_PATH=/data/share-p2.json \
  -e PORT=8002 \
  -v $(pwd)/apps/mpc-node/shares:/data:ro \
  -p 8002:8002 \
  soda-mpc-node

# Verify
curl http://localhost:8002/health
```

### On Coordinator

```bash
docker build -f apps/mpc-coordinator/Dockerfile -t soda-mpc-coordinator .

docker run -d --restart unless-stopped \
  --name mpc-coordinator \
  -e MPC_NODE_P1_URL=http://$P1_IP:8001 \
  -e MPC_NODE_P2_URL=http://$P2_IP:8002 \
  -e MPC_PEER_TIMEOUT_MS=60000 \
  -e PORT=8000 \
  -p 8000:8000 \
  soda-mpc-coordinator

# Verify — should show both peers' health + identical group_pk
curl http://localhost:8000/health
```

If `/health` returns timeouts, the security groups on `mpc-node-p1` /
`mpc-node-p2` aren't letting the coordinator's IP in. Fix the inbound
rules on `soda-mpc-p1-sg` / `soda-mpc-p2-sg`.

---

## Step 5 — Update the on-chain `group_pk`

The on-chain `Committee` PDA was initialized with the **v0** single-key
`group_pk`. To make MPC signatures verify under `secp256k1_recover`, the
on-chain key must match the joint MPC key.

If the soda program on devnet doesn't yet have the new
`update_committee` ix, deploy first:

```bash
# On your laptop
cd contracts
anchor build
anchor deploy --provider.cluster devnet
cd ..
```

Now run the migration. You need:
- The `group_pk` (X, Y) from Step 1 (or any share file)
- The wallet that originally called `init_committee` (it must match
  `Committee.authority`)

You don't have a share file on your laptop anymore. Either:

**(a)** Pull a copy back temporarily, run, shred:

```bash
ssh ubuntu@$P1_IP 'cat ~/frontier/apps/mpc-node/shares/share-p1.json' \
  > apps/mpc-node/shares/share-p1.json

ANCHOR_WALLET=~/.config/solana/id.json \
SOLANA_DEVNET_RPC_URL=<your-devnet-rpc> \
pnpm mpc:update-committee

shred -u apps/mpc-node/shares/share-p1.json
```

**(b)** Or run the script on the coordinator EC2 (it already has access
to both share files via SSH if you want, or pull just `share-p1.json`
from `mpc-node-p1`).

---

## Step 6 — Smoke test the live coordinator

From your laptop:

```bash
# Health: returns both peers' /health, including joint group_pk
curl http://$COORD_IP:8000/health

# Sign: drives the full 4-message protocol across two regions
curl -X POST http://$COORD_IP:8000/sign \
  -H 'content-type: application/json' \
  -d '{"payloadHex": "0000000000000000000000000000000000000000000000000000000000000001"}'
# returns { r, s, v }
```

Expected latency:

| Setup | First sign (cold) | Steady-state |
| --- | --- | --- |
| Same region, same AZ | ~400 ms | ~150 ms |
| Same region, different AZs | ~600 ms | ~250 ms |
| Cross-region (us-east-1 ↔ eu-west-1) | ~1.5 s | ~700 ms |
| Coordinator far from both nodes | ~2 s | ~1.2 s |

The 4-message protocol needs five HTTP round-trips coordinator ↔ peer.
Per-message Paillier crypto is ~50 ms; the rest is network.

---

## Step 7 — Run the SODA demo through the AWS committee

```bash
# On your laptop, point the subscriber at the AWS coordinator
MPC_COORDINATOR_URL=http://$COORD_IP:8000 pnpm mpc:subscribe

# In another terminal, kick off the demo as usual
./demo.sh
```

Full flow:

```
./demo.sh (laptop)
   │
   ▼
Solana devnet — SigRequested fires
   │
   ▼
mpc-subscriber (laptop) — picks up event, derives tweak
   │ POST http://COORD_IP:8000/sign
   ▼
mpc-coordinator (AWS) — drives 4 messages
   ├──→ mpc-node-p1 (AWS region A) ┐
   │                                ├── 4 round-trips
   └──→ mpc-node-p2 (AWS region B) ┘
   │
   ▼  { r, s, v }
mpc-subscriber — submits soda::finalize_signature
   │
   ▼
on-chain secp256k1_recover verifies, SigCompleted fires, demo continues to Sepolia broadcast.
```

---

## Configuration reference

### `mpc-node` env vars (set on each node EC2)

| Env var | Default | Notes |
| --- | --- | --- |
| `MPC_ROLE` | `p1` | Either `p1` or `p2`. Must match the share file's `role` field. |
| `MPC_SHARE_PATH` | `/data/share-p1.json` | Where the JSON share lives inside the container. |
| `PORT` | 8001 / 8002 | HTTP listen port. |

### `mpc-coordinator` env vars (set on the coordinator EC2)

| Env var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8000` | Coordinator API port. |
| `MPC_NODE_P1_URL` | `http://localhost:8001` | Public address of node P1 (use HTTPS in real prod). |
| `MPC_NODE_P2_URL` | `http://localhost:8002` | Public address of node P2. |
| `MPC_PEER_TIMEOUT_MS` | `60000` | undici timeouts to peers. Bump for far cross-region. |

### `mpc-subscriber` env vars (set wherever you run the subscriber)

| Env var | Default | Notes |
| --- | --- | --- |
| `SOLANA_RPC_URL` | falls back to devnet | RPC for log subscription + ix submission. |
| `MPC_COORDINATOR_URL` | `http://localhost:8000` | The coordinator's public URL. |
| `ANCHOR_WALLET` | `~/.config/solana/id.json` | Pays for `finalize_signature` txs. |

---

## Security checklist before any real (non-demo) deployment

1. **HTTPS in front of each node and the coordinator.** Caddy is the
   easiest:
   ```caddyfile
   p1.your-domain.com {
     reverse_proxy localhost:8001
   }
   ```
2. **Auth between coordinator and nodes.** Add a
   `Authorization: Bearer $SHARED_TOKEN` check in
   `apps/mpc-node/src/server.ts` and set the same env var on the
   coordinator. Two lines each.
3. **Encrypted shares at rest.** Wrap `share-p*.json` with
   `aws kms encrypt` before scp, decrypt at container startup using the
   EC2's instance-profile KMS access. Or use AWS Nitro Enclaves so the
   plaintext share never lives in the host's EBS volume.
4. **Restart on host reboot.** `docker run --restart unless-stopped`
   covers crashes but not host reboots — wrap in a `systemd` unit, or
   use the EC2's "auto-recovery" alarm.
5. **CloudWatch logs.** Add `--log-driver=awslogs` to each
   `docker run` so you can grep across all three hosts.
6. **No SSH from `0.0.0.0/0`.** Lock port 22 to your office IP, or
   require Session Manager via IAM.
7. **Different operators per node.** This guide assumes one person runs
   all three. The real production target is two unrelated operators
   running P1 and P2 (and a third for the coordinator, optionally
   permissionless), with restaking-bonded slashing — that's the v1
   roadmap.

---

## Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Connect Timeout Error` from `/health` | Coordinator can't reach node's port | Fix the security group on the node's EC2 (open 8001 / 8002 to coordinator's public IP). |
| `408 Request Timeout` | Free tunnel agent died (not relevant on AWS) | Use real EC2 + DNS instead. |
| `EADDRINUSE` on container start | Previous container still bound to the port | `docker rm -f mpc-node-p1` and re-run. |
| `foreign_pk mismatch — refusing to sign` (in mpc-subscriber) | Subscriber sees a different `group_pk` on-chain than the MPC committee holds | Run `pnpm mpc:update-committee` after DKG. |
| `AlreadyCompleted` (custom error 0x1770) | Some other process already finalized | Idempotent — treat as success. |
| Cold-start signs take 10-20 s | EC2's Node process hasn't JIT-warmed yet | Send a warm-up sign once after deploy. |

---

## Tear-down

```bash
# Stop containers on each host
for host in $P1_IP $P2_IP $COORD_IP; do
  ssh ubuntu@$host 'docker stop $(docker ps -q) && docker rm $(docker ps -aq)'
done

# Terminate instances
aws ec2 terminate-instances --instance-ids i-p1-xxxx --region us-east-1
aws ec2 terminate-instances --instance-ids i-p2-xxxx --region eu-west-1
aws ec2 terminate-instances --instance-ids i-coord-xxxx --region us-east-1

# Clean up security groups
aws ec2 delete-security-group --group-id sg-p1xxx --region us-east-1
aws ec2 delete-security-group --group-id sg-p2xxx --region eu-west-1
aws ec2 delete-security-group --group-id sg-coordxxx --region us-east-1
```

---

## Appendix: single-EC2 quick dev test (not for any real demo)

For very early local-equivalent testing on a single EC2 with all three
containers via `docker-compose.mpc.yml`:

```bash
ssh ubuntu@<single-ec2>
sudo apt install -y docker.io docker-compose-plugin
git clone https://github.com/derek2403/frontier
cd frontier
mkdir -p apps/mpc-node/shares
# scp both share files into apps/mpc-node/shares/ (defeats MPC isolation —
# only do this for one-off dev tests)
docker compose -f docker-compose.mpc.yml up -d --build
```

This is **not** an MPC deployment — both shares are on the same host, so
a single root compromise yields the full `group_sk`. Use only for
sanity-checking the build process. The real demo uses the three-EC2
setup above.
