`# SODA — Claude Code project notes

Hackathon build: a Solana program signs an Ethereum transaction. Pitch is "a
Solana PDA controls a `0x…` address; secp256k1_recover on Solana proves the
signature was produced by that PDA's derived key." See `docs/` and the README
for the full pitch.

The repo is at `~/code/frontier` (WSL native path). Anchor/Cargo work happens
inside `contracts/`. TS lives at the repo root via pnpm workspace
(`apps/*`, `packages/*`).

## Status (2026-05-11) — Phase 1 complete + MPC v0.5 in flight

### v0.5 (2026-05-11): real Lindell '17 2-of-2 MPC ECDSA

Replaced the v0 single-key signer with a real threshold-ECDSA committee.
Neither node ever sees the joint secret — DKG produces additive Paillier-
shared key material, and signing runs the 4-message Lindell '17 protocol
between two `mpc-node` peers, orchestrated by an `mpc-coordinator` that
only forwards opaque protocol bytes.

| Component | Path | Run | What it does |
|---|---|---|---|
| **mpc-node** | `apps/mpc-node/` | `MPC_ROLE=p1\|p2 pnpm dev` | Fastify HTTP service. Holds one share. POST /sign/init (P1 only) and POST /sign/step run the 4-message protocol. Optional `tweakHex` adds the SODA derivation tweak to P1's `x1` so the resulting sig recovers to `group_pk + tweak·G` (a SODA-derived foreign address). |
| **DKG ceremony** | `apps/mpc-node/scripts/dkg.ts` | `pnpm mpc:dkg` | Runs both contexts in-process and writes `share-p1.json` + `share-p2.json` to `apps/mpc-node/shares/` (gitignored). Outputs the joint `group_pk.x` / `group_pk.y` for the on-chain Committee. |
| **mpc-coordinator** | `apps/mpc-coordinator/` | `pnpm dev` (port 8000) | Stateless orchestration. POST /sign { payloadHex, tweakHex? } drives the 4 messages between P1 and P2, applies low-s normalization, returns `{ r, s, v }`. |
| **mpc-subscriber** | `apps/mpc-subscriber/` | `pnpm mpc:subscribe` | Subscribes to `SigRequested` on Solana, computes the tweak, calls coordinator, submits `finalize_signature`. Replaces `contracts/signer/` for MPC mode. |
| **update_committee ix** | `contracts/programs/soda/src/instructions/update_committee.rs` | `pnpm mpc:update-committee` | Authority-gated swap of on-chain `group_pk` so we can migrate from the v0 single key without redeploying. |
| **Docker stack** | `docker-compose.mpc.yml` | `pnpm mpc:up` | Three containers (p1, p2, coordinator) with healthchecks; mounts `apps/mpc-node/shares/` read-only. Foundation for AWS deploy. |
| **AWS deploy doc** | `apps/docs/pages/deploy/aws-mpc.mdx` | — | Step-by-step deploy of two `mpc-node` instances in different regions plus a coordinator. Honest about 2-of-2 caveats. |

Verified locally: DKG ceremony produces shares; both nodes report the same
`group_pk` on `/health`; coordinator's `/sign` produces signatures that
`@noble/curves` `verify(sig, payload, group_pk)` returns `true` for. Docker
build is the next-but-unbuilt step.

**v0.5 trust caveats (see `/concepts/committee` and `/deploy/aws-mpc`):**
- 2-of-2 means ZERO fault tolerance. v1 needs 2-of-3 minimum.
- Shares ship as plaintext JSON. Production wants Nitro Enclave / KMS wrap.
- Same person controls both nodes. Real decentralization needs different
  operators + restaking-bonded committee.

### v0 (2026-05-06): Phase 1 components that still work



### Components that work right now

| Component | Path | Run | What it does | Verified by |
|---|---|---|---|---|
| **soda program** | `contracts/programs/soda/` | (deployed) | On-chain SODA core: `init_committee`, `request_signature`, `finalize_signature` (with on-chain `secp256k1_recover`) | Live on devnet at `99apYWpnoMWwA2iXyJZcTMoTEag6tdFasjujdhdeG8b4`. 7 Rust unit tests pass (G+G=2G, etc). |
| **eth_demo program** | `contracts/programs/eth_demo/` | (deployed) | Demo harness: builds RLP, keccaks, CPIs into soda. Emits `EthTxRequested` event with the unsigned RLP for the relayer. | Live on devnet at `9g9eAkNbjpkVLi692vhgcUapJKS26yQTgsLzKbXKJXWM`. 9 Rust unit tests pass (EIP-155 mainnet vector). |
| **soda-sdk (TS)** | `packages/soda-sdk/` | `pnpm sdk:test` | Derivation, RLP encode/decode, EIP-155 v calc, EthRpc client. Source-only ESM workspace package consumed by demo + web + relayer. | 13/13 vitest parity tests (G+G=2G + EIP-155 canonical + RLP round-trip). |
| **CLI demo** | `apps/demo/` | `./demo.sh` (defaults to devnet) | One-shot orchestrator: validator/deploy/airdrop chores → init committee → sign on Solana → sign ECDSA → finalize on-chain → broadcast → auto-runs verify. | Multiple real Sepolia txs broadcast today; Etherscan + Solscan visible. |
| **verify tool** | `apps/demo/src/verify.ts` | `pnpm verify <eth_hash>` | Cryptographic audit: 6 checks tying the broadcast Sepolia tx back to the SigRequest PDA on Solana. Reads only public state. | Auto-chained from `demo.sh`; manually `pnpm verify 0x…` works against any past tx. |
| **Web UI** | `apps/web/` | `pnpm --filter web dev` → `http://localhost:3000` | Next.js page: derived address card, recipient input, button → SSE pipeline events → live 5-step timeline → Etherscan link. | End-to-end Sepolia tx via `/api/run` SSE this session. No wallet UI (server-driven). |
| **Signer daemon** | `contracts/signer/` | `pnpm signer` | Rust Tokio binary: log subscribe → tweak match → k256 sign → manual `finalize_signature` ix → submit. | Picked up live `SigRequested`, signed, submitted `finalize_signature` ahead of demo.ts this session. |
| **Relayer service** | `apps/relayer/` | `pnpm relayer:dev` | Node: `onLogs` → manual borsh decode of `EthTxRequested` + `SigCompleted` → assemble signed RLP → POST `eth_sendRawTransaction`. | Independently broadcast same Sepolia tx hash this session (idempotent with demo.ts). |

### End-to-end flow that's been verified

A single click in any of these surfaces produces a public Sepolia tx whose
`from` address is controlled by no private key — only the on-chain SODA
program:

1. `./demo.sh` (CLI, canonical) — orchestrates locally; daemon + relayer
   are optional but recommended for showing the architecture diagram.
2. `pnpm --filter web dev` + browser button — same pipeline through the
   web UI's SSE-streaming `/api/run`.

Both produce the same kind of artifact: an Etherscan link
(`https://sepolia.etherscan.io/tx/0x…`) plus matching Solscan links for
the `sign_eth_transfer` and `finalize_signature` Solana txs (decoded
properly on Solana Explorer / SolanaFM; Solscan shows them as "Unknown"
because Solscan doesn't auto-fetch Anchor IDLs).

### To show the full architecture (three terminals)

```bash
# Terminal 1 — Rust signer daemon (Tokio + k256)
pnpm signer

# Terminal 2 — Node relayer (events → broadcast)
pnpm relayer:dev

# Terminal 3 — kick it off
./demo.sh
```

Each process logs its own work; all three independently arrive at the same
on-chain `finalize_signature` and the same Sepolia tx hash. That's the
production-shape architecture — each piece talks only via on-chain events,
no shared in-process state.

### What's still cut for v0 (Phase 3+ work)

These are intentional simplifications for the hackathon — see "The legit
flow" below for the production-shape design:
- **Single dev k256 signer** (`keyshare.dev.json`) is the v0 path.
  v0.5 (2026-05-11) replaced this with real Lindell '17 2-of-2 MPC ECDSA
  via `apps/mpc-node` + `apps/mpc-coordinator`. Both modes coexist; pick
  one at demo time. v1 still wants 2-of-3+ with restaking-bonded
  operators (FROST is Schnorr-only, so threshold ECDSA stays in the
  GG18 / GG20 / CGG21 family).
- **`foreign_pk = group_pk + tweak·G` is computed off-chain by the caller**
  and passed in to `soda::request_signature`. The on-chain program just
  compares `secp256k1_recover(payload, sig, recovery_id)` to the stored
  bytes — it does NOT verify the caller computed `foreign_pk` correctly.
  (Earlier attempt at on-chain `k256::ProjectivePoint` ops blew the BPF
  4KB stack — re-enabling needs heap-Box / inline-never / new syscall.)
- **Web UI runs server-side** — no wallet-adapter; the server's CLI wallet
  signs Solana txs. Reintroducing Phantom is Phase 2 polish.
- **No anti-replay** on `SigRequest` beyond PDA seed uniqueness; no
  expiry enforcement.
- **No BTC support** — §8's BTC harness is paused. Adding BTC means a
  `programs/btc_demo/`, a `packages/soda-sdk/src/bitcoin.ts`, and a second
  relayer assembler path. The SODA core program stays unchanged.
- **No source-verified badge on Solscan** — needs `solana-verify` +
  public GitHub repo.

**Toolchain (verified installed):** Rust 1.95.0, Solana CLI 3.1.14, Anchor
0.32.1, Node 24.10.0, pnpm 10.33.2.

## The demo flow (what `./demo.sh` does today)

1. `demo.sh` (bash): start validator if not running, airdrop SOL, run
   `anchor deploy` if programs aren't on-chain.
2. `demo.ts` (Node): load Solana wallet + dev k256 signer key, init the SODA
   committee on first run.
3. TS-side derivation: `tweak = sha256("SODA-v1" || eth_demo_id || seeds ||
   chain_tag)`, `foreign_pk = group_pk + tweak·G`, `eth_addr = keccak256(
   uncompressed[1..])[12..]`. Print derived ETH address.
4. Poll Sepolia balance for the derived address until ≥ 0.0002 ETH.
5. Build legacy + EIP-155 unsigned RLP for a 0.0001 ETH transfer (default:
   self-transfer to the derived address). keccak256 → 32-byte payload.
6. Call `eth_demo::sign_eth_transfer(foreign_pk_xy, to, value, nonce,
   gasPrice, gasLimit, seeds)`:
   - eth_demo builds the same RLP on-chain, keccak's, then CPIs
     `soda::request_signature(foreign_pk_xy, seeds, payload, chain_tag)`.
   - soda creates `SigRequest` PDA, emits `SigRequested`.
7. Off-chain: sign payload with `k256` using tweaked SK
   `sk' = (group_sk + tweak) mod n`. The recovered pubkey for any signature
   from `sk'` is exactly `group_pk + tweak·G = foreign_pk`.
8. Call `soda::finalize_signature(signature, recovery_id)`:
   - soda runs `solana_program::secp256k1_recover` syscall (~25k CU).
   - Compares recovered 64-byte X||Y to `sig_request.foreign_pk_xy`.
   - On match: writes the signature, marks completed, emits `SigCompleted`.
9. Off-chain: build `RLP([..., v, r, s])` with `v = recoveryId + 35 + 2*chainId`,
   POST `eth_sendRawTransaction` to Sepolia, print Etherscan link.

## The legit flow (production-shape design)

This is what the demo is a stepping stone toward. Everything below is
**deferred** — do not "sneak" any of it into the demo without an explicit
scope decision.

### 1. On-chain verification of foreign_pk derivation
Today the on-chain program trusts the caller's `foreign_pk_xy`. Production
needs `soda` to verify `foreign_pk = group_pk + tweak·G` itself. Earlier
attempt (k256 `ProjectivePoint` ops on-chain) blew the BPF 4KB stack. Real
options to revisit:
- `Box::new` the heavy intermediates to put them on heap (32KB available).
- Split into many `#[inline(never)]` functions to spread stack frames.
- Wait for / lobby for a Solana point-add syscall.
- Verify via a zk proof (alt-bn128 syscalls already available; secp256k1
  via custom circuit).

### 2. Real threshold-ECDSA committee (vs single dev signer)

**v0.5 (2026-05-11): partly done.** Real Lindell '17 2-of-2 ECDSA via
`@safeheron/two-party-ecdsa-js`. Two `apps/mpc-node` processes hold
shares (`x1` + `x2` such that `x1 + x2 = group_sk`); neither sees the
joint secret. Sign runs the 4-message protocol; output `(r, s, v)` is
a normal ECDSA signature that `secp256k1_recover` verifies on-chain
identically to v0. Tweak handling: P1 adds the SODA tweak to its share
before signing, so the resulting sig recovers to `group_pk + tweak·G`
(the SODA-derived foreign address) without changing the protocol.

**Still TODO for v1:**
- 2-of-3+ instead of 2-of-2. Lindell '17 doesn't generalize; we'd swap
  to GG18 / GG20 / CGG21 (Rust `multi-party-ecdsa` or `cggmp24`). FROST
  is Schnorr-only, so it doesn't apply for ECDSA.
- Different operators per node + bonding via restaking (Solayer / Jito).
  Today both nodes are containers under the same operator.
- Nitro-Enclave / KMS-wrapped shares at rest. Today shares are
  plaintext JSON.
- Slashing on misbehavior via on-chain proofs.

### 3. Signer daemon (Rust binary at `contracts/signer/`)
**Done.** Tokio binary at `contracts/signer/src/{main,config,derive,event,ix}.rs`
that:
- Loads keystore (`keyshare.dev.json`) and payer (`~/.config/solana/id.json`).
- Pubsub-subscribes to logs filtered by SODA program ID via
  `solana_client::nonblocking::pubsub_client::PubsubClient`.
- Decodes `SigRequested` from `Program data: <base64>` log lines using a
  borsh-derived struct + `sha256("event:SigRequested")[..8]` discriminator.
- Iterates `SODA_KNOWN_REQUESTERS` (default: just `eth_demo`'s ID), computes
  `foreign_pk = group_pk + tweak·G` for each candidate program, picks the
  one whose result equals `event.foreign_pk_xy`. This is the off-chain
  equivalent of "which program is asking?" — needed because we removed
  `requester_program` from the event during the BPF-stack refactor.
- Signs `event.payload` with `(sk + tweak) mod n` via
  `k256::ecdsa::SigningKey::sign_prehash_recoverable`.
- Builds + sends `finalize_signature` ix manually (no `anchor-client` dep):
  8-byte discriminator `sha256("global:finalize_signature")[..8]` followed
  by borsh-encoded `(signature: [u8;64], recovery_id: u8)`.
- Idempotent: races with `apps/demo` and `apps/relayer`; if Solana returns
  `AlreadyCompleted` (custom error 0x1770) the daemon treats it as success.

Run: `pnpm signer` (or `cargo run -p signer` from `contracts/`).
Env: `SOLANA_RPC_URL` / `SOLANA_DEVNET_RPC_URL` (auto-loaded from `.env`),
optionally `SODA_PROGRAM_ID`, `SODA_KNOWN_REQUESTERS`,
`SODA_SIGNER_KEY_PATH`, `ANCHOR_WALLET`.

Still deferred (Phase 3+):
- Multi-signer FROST committee — replace the single `keyshare.dev.json`
  with t-of-n share commitment + partial-signature submission via a
  separate `submit_share` ix on soda. Today there's just one signer.
- HSM/KMS keystore — currently a hex file on disk.
- Multi-region / failover.

### 4. TS SDK package (`packages/soda-sdk/`)
**Done.** Extracted from `apps/demo` on 2026-04-29. Source-only ESM package
shared by `apps/demo` and `apps/web` via `workspace:*` + Next.js
`transpilePackages: ["soda-sdk"]`. Vitest parity tests live with the source.
Current exports (from `src/index.ts`):
- `computeTweak`, `deriveForeignPk`, `ethAddressFromPk`, `deriveEthAddress`
- `bigintToBe`, `bytesToBigInt`
- `encodeUnsignedLegacy`, `encodeSignedLegacy`, `eip155V`, `LegacyTx`
- `EthRpc` class (`getBalance`, `getNonce`, `getGasPrice`, `sendRawTransaction`)
- `DERIVATION_DOMAIN`, `ETH_SEPOLIA_CHAIN_TAG`

Still deferred:
- `request.signEthTransfer(...)` — convenience wrapper that builds the
  `eth_demo` ix, awaits `SigCompleted`, returns assembled signed RLP. Today
  this lives split between `apps/demo/src/demo.ts` and
  `apps/web/lib/run-demo.ts`. Should consolidate into the SDK.
- `chains/`: per-chain encoders. Current: `ethereum.ts` only. Next:
  `bitcoin.ts` (BIP143 sighash, P2WPKH).

### 5. Relayer service (`apps/relayer/`)
**Done.** Standalone Node service that:
- Connects to Solana via `@solana/web3.js` `Connection.onLogs` for both
  the soda program ID and the eth_demo program ID.
- Decodes `EthTxRequested` (eth_demo) and `SigCompleted` (soda) directly
  from the `Program data: <base64>` log lines using event discriminators
  from the IDLs + a hand-written 30-LOC borsh reader. **Anchor 0.32.1's
  `Program.addEventListener` doesn't dispatch on this IDL spec because
  event field types live in the `types` array rather than inline; the
  manual decoder works around it.**
- On `EthTxRequested`: caches `(sig_request, chain_id, unsigned_rlp)`
  by sig_request key.
- On `SigCompleted`: looks up cached `unsigned_rlp`, calls
  `decodeUnsignedLegacy` from soda-sdk, re-encodes with `(v, r, s)` via
  `encodeSignedLegacy`, POSTs `eth_sendRawTransaction` to Sepolia,
  prints the Etherscan link.
- Idempotent: handles "already known" / "nonce too low" gracefully so it
  can run alongside `apps/demo` (they both attempt the broadcast; whichever
  reaches Sepolia first wins, the other just observes).

Run: `pnpm --filter relayer dev` (or `pnpm relayer:dev` from root).
With `RELAYER_DEBUG=1`, also prints every WS log batch for diagnostics.

Still deferred:
- Multi-chain dispatch by `chain_tag` (today only ETH/Sepolia).
- Pluggable broadcast targets (Alchemy / Infura / public RPC fallback).
- Persistent cache so relayer restart doesn't lose pending unsigned RLPs.

### 6. Web UI (`apps/web/`)
**Working but de-prioritized.** Next.js 16 + Pages router + Tailwind 4. One
page that auto-derives the ETH address (via `/api/group-pk`), polls Sepolia
balance, and runs the whole pipeline server-side via `/api/run` (SSE-streaming
Solana txs + k256 signing + broadcast). Five-step Timeline animates as the SSE
events come in.

Wallet-connect UI was removed — user prefers the CLI demo (`./demo.sh`) for
showing on stage. The web is kept as a working backup; reintroducing
`@solana/wallet-adapter-*` so users can sign their own Solana txs is a Phase 2
task. The current UI runs fine without Phantom because everything happens
server-side.

Still deferred:
- Wallet-adapter reintroduction (Phantom signs Solana txs in production shape).
- Live timeline that subscribes to Solana logs directly (vs. SSE relay).
- QR code rendering on the derived-address card.

### 7. Multi-chain
ETH-only is the v0 cut. Adding BTC: `programs/btc_demo/`,
`packages/soda-sdk/src/bitcoin.ts`, second relayer path. SODA core program
stays unchanged.

## Repo layout

```
contracts/                       — all Cargo + Anchor lives here
  Anchor.toml                    — workspace config (program IDs, provider)
  Cargo.toml                     — Rust workspace (programs/* + signer/)
  programs/soda/src/
    lib.rs                       — #[program] mod, declare_id, ix dispatch
    state.rs                     — Committee, SigRequest, events
    errors.rs                    — SodaError codes
    derivation.rs                — Rust derivation impl, #[cfg(test)] only
                                   (kept for cross-language parity tests vs TS)
    instructions/
      init_committee.rs
      request_signature.rs       — stores foreign_pk_xy + payload + seeds
      finalize_signature.rs      — secp256k1_recover + compare to stored
  programs/eth_demo/src/
    lib.rs                       — sign_eth_transfer (builds RLP, CPIs soda)
    eth_rlp.rs                   — RLP encoder for legacy + EIP-155
    state.rs                     — PendingTx (unused for now; relayer-side use later)
  signer/                        — Rust signer daemon (`pnpm signer`)
    src/{main,config,derive,event,ix}.rs — log subscribe → tweak match →
                                            k256 sign → manual finalize ix
  tests/                         — Anchor mocha tests (empty)
  target/idl/                    — generated by anchor build, consumed by TS

apps/demo/                       — one-shot CLI demo (Node + TS via tsx)
  src/demo.ts                    — main flow; imports everything from soda-sdk

apps/web/                        — Next.js 16 (Pages router) + Tailwind 4
  pages/index.tsx                — single-page demo
  pages/_app.tsx                 — root (no wallet-adapter; UI is server-driven)
  pages/api/group-pk.ts          — returns dev signer's compressed pubkey
  pages/api/run.ts               — SSE stream of pipeline events; returns RunResult
  lib/run-demo.ts                — server-side runDemo function (SSE-driven)
  lib/idls.ts                    — re-exports contracts/target/idl JSONs
  components/{DerivedAddressCard, SignAndSendButton, Timeline, SignedHexView}.tsx
  next.config.ts                 — has transpilePackages: ["soda-sdk"]
  .env.local                     — local-only; mirrors repo-root .env

apps/relayer/                    — Node service (event subscriber + broadcaster)
  src/index.ts                   — onLogs → manual borsh decode → assemble + send

packages/soda-sdk/               — TS source-only ESM workspace package
  src/derive.ts                  — TS derivation (parity with derivation.rs)
  src/rlp.ts                     — TS RLP encoder + signed-tx assembler
  src/sepolia.ts                 — EthRpc class (JSON-RPC client)
  src/index.ts                   — barrel re-exports
  src/derive.test.ts             — parity tests (G+G=2G vector)
  src/rlp.test.ts                — parity tests (EIP-155 canonical vector)

demo.sh                          — cluster-aware wrapper (default: devnet)
.env                             — local-only, gitignored; SEPOLIA_RPC_URL +
                                    HELIUS_API_KEY + SOLANA_DEVNET_RPC_URL
keyshare.dev.json                — local-only, gitignored; dev k256 SK
.last-tx-hash                    — local-only, gitignored; written by demo.ts
                                    so demo.sh can chain into pnpm verify
```

## How to run

**Once-per-machine setup** (already done on this WSL):
- WSL Ubuntu, Solana toolchain via `https://solana-install.solana.workers.dev`
- `pnpm install` from repo root
- Solana wallet at `~/.config/solana/id.json`
- `.env` with `SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/...`

**Each demo (the canonical path — CLI):**
```bash
cd ~/code/frontier
./demo.sh                                         # default: devnet, self-transfer
DEMO_RECIPIENT=0xSomeAddress ./demo.sh            # send to specific recipient
SODA_DRY_RUN=1 ./demo.sh                          # skip Sepolia, verify on-chain only
SOLANA_CLUSTER=local ./demo.sh                    # against local validator (free SOL, ephemeral)
```

After a successful broadcast, `demo.sh` automatically runs `pnpm verify <hash>`
which prints the cryptographic audit trail (8 checks tying the Solana
SigRequest to the broadcast Sepolia tx).

The Sepolia ETH on the derived address only depletes at ~0.0002 ETH per run
(gas only when self-transferring). Devnet SOL on the wallet only depletes at
a few thousand lamports per run.

**Web UI (backup, same flow but in a browser):**
```bash
# Terminal A: validator + deploy (re-run if validator was reset)
solana-test-validator --reset
# Terminal B:
cd contracts && anchor deploy
cd .. && pnpm --filter web dev
# open http://localhost:3000 → click "Sign & broadcast"
```

The dev signer key persists, so the derived ETH address is fixed at
`0x13ea4bd81b997103cc0dd57b58307ce952268a37` until `keyshare.dev.json` is
deleted. Fund it once on Sepolia, demo many times.

**Tests:**
```bash
cd contracts && cargo test --workspace --lib   # 16 Rust unit tests
pnpm sdk:test                                  # 10 TS parity tests
```

## Active design decisions to remember

- **Off-chain derivation is a deliberate cut, not a bug.** The first attempt
  did on-chain `group_pk + tweak·G` via k256, blew the BPF stack. Re-enabling
  this requires the heap-Box / inline-never / syscall path described above.
  See `derivation.rs` (test-only) for the algorithm.
- **`requester_program` was removed from `SigRequest`** during the refactor.
  It was used when on-chain derivation needed it; with off-chain derivation
  it's no longer needed in the on-chain account. The TS SDK still uses
  `eth_demo`'s program ID as the derivation input, but soda doesn't
  re-derive so doesn't need it stored.
- **EIP-155 v** is computed by the *caller* (TS / relayer), not stored
  on-chain. soda stores `recovery_id` (0/1) only.
- **Self-transfer is the default demo recipient** so each run only burns
  gas. Override with `DEMO_RECIPIENT` for a more visually striking pitch.
- **CLI is the canonical demo, web is backup.** The user explicitly chose
  to demo the CLI (`./demo.sh`) on stage because it's "just a button" in the
  UI. Don't invest UI polish unless the user reverses this. Wallet-adapter
  was removed for the same reason.
- **`soda-sdk` is a TS-source workspace package.** It exports `.ts` files
  directly (no build step). `apps/web` requires `transpilePackages: ["soda-sdk"]`
  in `next.config.ts`; `apps/demo` works because tsx handles TS imports.
  Adding chain-specific encoders (e.g. `bitcoin.ts`) goes here, not into the
  consuming apps.
- **Web UI runs server-side.** `/api/run` does the whole pipeline (Solana
  txs + k256 signing + Sepolia broadcast) and streams progress events to the
  page over SSE. The page never holds a private key. When the standalone
  signer daemon and relayer ship (Tasks #19, #20), `/api/run` becomes a thin
  trigger that just broadcasts the first Solana ix and watches for events.
- **Devnet is the default cluster** (changed from local on 2026-04-29). The
  user wanted Solscan-visible txs to demo with. Local validator is still
  supported via `SOLANA_CLUSTER=local ./demo.sh` for fast iteration. Helius
  RPC URL lives in `.env` (`SOLANA_DEVNET_RPC_URL`) and is auto-loaded by
  both `demo.sh` and `verify.ts`.
- **`./demo.sh` chains demo → verify automatically.** demo.ts writes the
  broadcast ETH tx hash to `.last-tx-hash`; the wrapper reads it and runs
  `pnpm verify <hash>` after the demo completes (skipped on dry-run since
  there's no real broadcast). Judges/viewers see the cryptographic audit
  without needing to copy/paste a hash between commands.

## AWS MPC committee — live as of 2026-05-11

The Lindell '17 2-of-2 committee from `aws.md` is now running on AWS. End-to-end
signature test confirmed working: a `POST /sign` to the coordinator returns a valid
`{r, s, v}` in ~400ms after the cold JIT warmup.

### Deployed topology

Three t3.small Amazon Linux 2023 instances in us-east-1, same VPC
(`vpc-0d8e8a263c8c8e744`), same subnet (`subnet-0d47af10344722ae0`):

| Role | Public IP | Private IP | Instance ID | Container |
|---|---|---|---|---|
| mpc-node-p1 | 44.201.168.181 | 172.31.94.167 | i-0af59c78f56604fc7 | `soda-mpc-node` (MPC_ROLE=p1, port 8001) |
| mpc-node-p2 | 54.88.35.104 | 172.31.92.69 | i-067f5ad3e18c1c4f4 | `soda-mpc-node` (MPC_ROLE=p2, port 8002) |
| mpc-coordinator | 32.198.7.34 | 172.31.89.14 | i-0226d17a7795e7f53 | `soda-mpc-coordinator` (port 8000) |

PEM files (`~/Downloads/`): `soda-mpc-node-p1.pem`, `soda-mpc-node-p2.pem`,
`soda-mpc-coordinator.pem`. Default SSH user is `ec2-user`.

### Security group rules added (manual, in console)

- coordinator SG: inbound TCP 8000 from `0.0.0.0/0` (laptop + relayer)
- node-p1 SG: inbound TCP 8001 from `172.31.89.14/32` (coordinator's private IP)
- node-p2 SG: inbound TCP 8002 from `172.31.89.14/32` (coordinator's private IP)

Same-region (no cross-region). `aws.md` notes cross-region is recommended for the
"two operators in different failure domains" claim. The hackathon trade-off was
latency over geographic diversity.

### DKG output (run locally on 2026-05-11)

```
group_pk.x = 45023a23c8bcf5c404eec8e6ba82c755ed9c62c9e47163e21469ba3979e6c9a2
group_pk.y = 2fdd84a8e4f653f65011c90f559f9b61bfbdd7290a1493773a59d248bfe01349
```

Shares were shipped to the nodes via `scp` and are mounted at `/data/share-p*.json`
inside each container. Local copies are still on the laptop until on-chain
`update_committee` is run (step 2 in "What's next"). After that they get wiped.

### Verified working

```
$ curl http://32.198.7.34:8000/health
{"ok":true,"peers":{
  "p1":{"ok":true,"role":"p1","groupPkXY":{"x":"45023a23...c9a2","y":"2fdd84a8...1349"}},
  "p2":{"ok":true,"role":"p2","groupPkXY":{"x":"45023a23...c9a2","y":"2fdd84a8...1349"}}
}}

$ curl -X POST http://32.198.7.34:8000/sign \
    -d '{"payloadHex":"0000000000000000000000000000000000000000000000000000000000000001"}'
{"r":"948ea1d1...","s":"10ccb558...","v":0}
```

### Deploy script

`scripts/deploy-mpc-aws.sh` (added 2026-05-11) automates the whole flow from the laptop:
- `git fetch && reset --hard origin/main` on each EC2 (idempotent re-deploy)
- SCPs the local `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` as overrides
  so unpushed local fixes deploy without needing a commit
- SCPs share files to the right node
- `docker build` + `docker run` with the right env vars
- Retry-loop healthcheck (30s) on each container

Edit the IPs at the top of the script if any instance is replaced. Run from repo root:
```
bash scripts/deploy-mpc-aws.sh
```

### Issues hit during the first deploy (for the next round)

- **`pnpm mpc:dkg` wrote shares to `apps/mpc-node/apps/mpc-node/shares/`** because
  the root script passed relative paths and pnpm chdir'd into the workspace first.
  Fixed in root `package.json` by using `../../apps/mpc-node/shares/...` paths.
  Same fix applied to `mpc:update-committee`.

- **pnpm 11 `ERR_PNPM_IGNORED_BUILDS` blocked docker builds** because native deps
  (esbuild, sharp, bufferutil, protobufjs, unrs-resolver, utf-8-validate) need
  explicit approval. Fixed by:
  - `"packageManager": "pnpm@11.0.9"` added to root `package.json` so corepack uses
    matching pnpm inside the Docker build
  - `pnpm-workspace.yaml` declares both `allowBuilds: {...}` (map form, all `true`)
    and `onlyBuiltDependencies: [...]` (array form) for forward compat

- **Initial 3-second healthcheck timed out** even though containers were fine —
  corepack pulls pnpm and tsx warms up on first run. Replaced with a 30-second
  retry loop.

- **EC2 security groups don't open MPC ports by default.** Required three manual
  console edits (see "Security group rules added"). Worth scripting via AWS CLI
  next time.

## What's next (handed off)

1. **`anchor build`** to generate the program IDL at `contracts/target/idl/soda.json`.
   The `mpc:update-committee` script reads this file to know the program's instructions.
   ```
   cd contracts && anchor build && cd ..
   ```

2. **Update the on-chain Committee PDA** with the joint `group_pk` (values above):
   ```
   ANCHOR_WALLET=~/.config/solana/id.json \
   SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com \
   pnpm mpc:update-committee
   ```
   The wallet at `~/.config/solana/id.json` must match the `Committee.authority` (the
   wallet that originally called `init_committee`). If it errors with an auth check,
   that's the cause.

3. **Run the demo end-to-end through AWS:**
   ```
   # terminal 1
   MPC_COORDINATOR_URL=http://32.198.7.34:8000 pnpm mpc:subscribe
   # terminal 2
   ./demo.sh
   ```
   Expected flow: subscriber sees `SigRequested` on devnet → POSTs to AWS coord →
   gets `{r,s,v}` → submits `finalize_signature` → demo continues to Sepolia broadcast.

4. **Wipe local share files** once step 3 succeeds:
   ```
   rm -P apps/mpc-node/shares/share-p1.json apps/mpc-node/shares/share-p2.json
   ```
   After this, the only places the shares exist on Earth are inside the two EC2 nodes.
   This is the property MPC is supposed to give: no single host holds both shares.

5. **Pre-warm the committee before demo day.** First `/sign` after a container restart
   takes ~1.5s (cold JIT + corepack pull). Run one warmup `/sign` ~5 minutes before any
   judge sees the demo.

## Pointers

- Master plan (BTC-first §8): `C:\Users\User\.claude\plans\hi-i-wanted-to-linear-catmull.md`
- ETH-v0 plan: `C:\Users\User\.claude\plans\read-the-whole-idea-misty-lagoon.md`
- Project memory: `~/.claude/projects/-home-user-code-frontier/memory/`
  (mirrored from the Windows-side `c--Code-frontier/memory/`)
