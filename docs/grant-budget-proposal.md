# SODA — Chain Signatures for Solana

## Budget proposal for the Solana Foundation

Prepared 17 September 2026. All amounts in USD. Rates are stated so they can
be adjusted; every line is either a person-month, a quote range, or a
verified running cost.

---

## 1. What we are asking for

**$248,000 over 9 months, paid in five milestone tranches**, to take SODA
from a working devnet prototype to an audited mainnet-beta with an
independent, attested t-of-n signing committee. This is the Solana-native
equivalent of NEAR Chain Signatures: every Solana account and program gets a
deterministic address on every other chain, usable with one Solana signature
and verified on-chain before broadcast.

The total programme cost is **$429,000**. The Foundation grant covers the
public-good core: the program, the node, the audits and the operator
programme. The remaining $181,000 is engineering time we are funding through
Superteam Malaysia support, a Sui Foundation adapter grant we are applying
for, and founder contribution. Section 7 shows the split.

A lean option at **$168,000** is in section 8.

---

## 2. What already exists (not in this budget)

Roughly seven engineer-months of work is live on devnet and reproducible
from the public repo. It reduces the risk of every milestone below.

| Built and verified | Where |
|---|---|
| `soda` program: `request_signature` derives the foreign key on-chain from the signer via the `secp256k1_recover` trick; `finalize_signature` verifies the committee's signature on-chain before anything is broadcast | `contracts/programs/soda` |
| EVM adapter: Ethereum Sepolia, Base Sepolia; Aave V3 deposit and borrow executed from a Solana-owned address | `packages/soda-sdk`, `contracts/programs/eth_demo` |
| Sui adapter (non-EVM): BCS envelope encoded on-chain, DeepBook trades executed from a Solana-owned address | `packages/soda-sdk/src/sui.ts`, `contracts/programs/sui_demo` |
| Program-owned addresses: a PDA vault owns an EVM address and refuses to sign for any recipient but the one recorded at creation | `contracts/programs/vault_demo` |
| Public audit tool tying any broadcast transaction back to its Solana request from public state alone | `apps/demo/src/verify.ts`, `verify-sui.ts` |
| 2-of-2 threshold ECDSA committee (Lindell '17), web demo with Phantom, CLI demo, documentation site | `apps/mpc-*`, `apps/web`, `apps/docs` |

What does not exist yet is exactly what this proposal funds: a t-of-n
committee with independent operators, hardware attestation, audits, a fee
mechanism, and a Bitcoin adapter.

---

## 3. Milestones

Each milestone has a deliverable the Foundation can verify without trusting
us: a public devnet or mainnet address, a passing CI run, or a published
report. Chapters refer to the NEAR Chain Signatures architecture the design
follows.

Milestone amounts below are engineering allocations from section 4.1; they
sum to the $228,000 people line. Audits are shown separately under M5.
Grant tranches (section 5) are disbursement timing, not cost accounting.

### M1 · Hardening and fee hook — months 1–2 — $30,000

Closes the gaps a second engineer or an auditor would hit first.

- Enforce request expiry in `finalize_signature` (written today, never checked).
- `fee_bps` field on `Committee` and a lamport transfer in `request_signature`, shipped at zero. Retrofitting a fee after integrators exist is a breaking change.
- Add `chain_tag` to `SigRequest` seeds so two chains can never collide on one payload.
- One responder service replacing the five copies of sign → finalize → broadcast.
- Single source of truth for IDLs and program IDs with a CI drift check; full CI (Rust, TypeScript, litesvm program tests, golden derivation vectors shared by Rust and TS).
- Anchor CPI crate (`soda-interface`) so a third-party program can request a signature with one dependency.

**Acceptance:** CI green on a public runner; expiry and fee covered by program tests; `vault_demo` re-run on devnet through the new responder.

### M2 · t-of-n committee — months 2–5 — $96,000

The core of the proposal. Replaces the 2-of-2 with a real threshold network (guide chapters 7–10, 12).

- Rust node built on NEAR's MIT-licensed, Trail-of-Bits-audited `threshold-signatures` crate: PedPop+ DKG without a trusted dealer, OT-based ECDSA with triples and presignatures, and additive derivation folded into the presignature (Groth–Shoup), which fixes the tweak limitation of the current 2-of-2.
- Durable one-time-material store with consumption markers that survive crashes and restarts (chapter 14).
- Authenticated peer channels (mTLS), Solana observation through multiple independent RPC providers with k-of-n agreement on what the chain said before any signing starts.
- On-chain operator registry: participants, threshold, epoch; resharing and refresh so membership can change without changing any derived address.
- Launch at 2-of-3, move to 3-of-5 as operators are onboarded.

**Acceptance:** 3-of-5 committee on devnet with three independent operators, each signing from a different provider and region; resharing executed once with all derived addresses unchanged; every existing demo re-run through it.

### M3 · Attested operators — months 4–6 — $42,000

Operators cannot read shares or swap the code without the chain noticing (chapter 13).

- Nodes run inside Intel TDX confidential VMs via dstack (the same runtime NEAR uses), initially on Phala Cloud so operators need no hardware.
- Launcher measures the node image; attestation quote binds the node's TLS key and Solana key; shares sealed to the measurement.
- Attestation registry on the `Committee` account with approved image hashes, authority-set at first, vote-gated once the registry has members; off-chain verifier published so anyone can check every operator.
- Backup and migration tooling for shares.

**Acceptance:** testnet committee where every operator's quote verifies against the published measurements; a node running an unapproved image is refused by the registry.

### M4 · SDK, adapters, integration kit — months 5–7 — $36,000

What a wallet or protocol needs to integrate in a day (chapter 15).

- `ChainAdapter` interface with EVM (legacy and EIP-1559), Sui, and **Bitcoin** (BIP143, P2WPKH) implementations; the program is already chain-agnostic, so this is SDK work only.
- Published packages: `@sodabuild/core`, `@sodabuild/program` (IDLs, ids, PDA helpers), the `soda-interface` Anchor crate.
- Integration checklist and reference apps (vault, Aave, DeepBook, a Bitcoin spend).
- Operator kit: one container, health and metrics endpoints, onboarding guide.

**Acceptance:** a Bitcoin testnet spend from a Solana-owned address, audited by the verify tool; packages published; a third-party developer integrates from the docs alone in a recorded session.

### M5 · Audits and mainnet-beta — months 7–9 — $24,000 engineering + $105,000 audits

- Program audit (Solana-specialist firm): `soda`, the CPI crate, the derivation trick.
- Node and integration audit: our use of the threshold crate, derivation-in-presignature, one-time-material lifecycle, Solana observation.
- TEE and attestation review.
- Mainnet-beta with five operators, a TVL cap per epoch, gas relayer billing users in SOL, and one pilot partner treasury address on Base.

**Acceptance:** audit reports published in the repo with fixes mapped to commits; mainnet-beta program and committee addresses public; pilot transaction audited end to end.

### Optional M6 · Ed25519 domain — months 9–11 — $28,000 (not in the ask)

FROST-based Ed25519 signing (chapter 11) so Solana-owned addresses extend to Ed25519 chains, plus private requests through MagicBlock's TEE rollups. Listed so the Foundation sees where the roadmap goes; can be a follow-on grant.

---

## 4. Cost breakdown

### 4.1 People — $228,000

| Role | Rate / month | Months | Cost | Notes |
|---|---|---|---|---|
| Lead engineer (founder) | $6,000 | 9 | $54,000 | Program, architecture, operator programme, below market |
| Rust / MPC engineer | $14,000 | 8 | $112,000 | Node, threshold protocol integration, TEE launcher |
| SDK / frontend engineer | $6,000 | 6 | $36,000 | Adapters, packages, reference apps, docs |
| DevOps / security (part-time) | $6,500 | 4 | $26,000 | CI, TEE deployment, audit coordination, incident runbooks |

### 4.2 Security audits — $105,000

| Scope | Estimate | Basis |
|---|---|---|
| Solana programs + CPI crate + derivation trick | $40,000 | Solana-specialist firm, ~3 weeks |
| Node, threshold-crate integration, derivation-in-presignature, material lifecycle | $50,000 | Reduced because the underlying protocol crate already carries four Trail of Bits audits; we audit our integration, not the protocol |
| TEE launcher and attestation flow | $15,000 | ~1 week review |

Quotes will be obtained at M1; if they come in lower the difference returns to contingency.

### 4.3 Operator programme — $30,000

| Item | Cost | Notes |
|---|---|---|
| Operator stipends: 5 × $400 × 12 months | $24,000 | Covers each operator's machine; paid monthly in USDC on uptime |
| Onboarding and operator support | $6,000 | Kit maintenance, calls, incident handling |

NEAR's committee reached 15 operators paid nothing on-chain. We budget stipends so cost is never the reason a good operator says no.

### 4.4 Infrastructure — $31,000

| Item | Monthly | Months | Cost |
|---|---|---|---|
| TEE confidential VMs, 5 nodes on Phala Cloud | $750 | 12 | $9,000 |
| Solana RPC (team node plus provider plans for operators) | $1,200 | 9 | $10,800 |
| Destination-chain RPC (EVM, Sui, Bitcoin) | $400 | 9 | $3,600 |
| Devnet/testnet/mainnet program deploys, rent, extensions | | | $2,600 |
| Gas-relayer float for the pilot | | | $5,000 |

### 4.5 Other — $35,000

| Item | Cost |
|---|---|
| Legal: entity, operator agreements, pilot terms | $10,000 |
| Contingency (about 6% of the total) | $25,000 |

### 4.6 Total

| Category | Cost |
|---|---|
| People | $228,000 |
| Audits | $105,000 |
| Operator programme | $30,000 |
| Infrastructure | $31,000 |
| Other | $35,000 |
| **Total programme** | **$429,000** |

---

## 5. Tranche schedule (the $248,000 ask)

| Tranche | On completion of | Amount | Cumulative |
|---|---|---|---|
| 1 | Grant approval | $30,000 | $30,000 |
| 2 | M1 accepted | $38,000 | $68,000 |
| 3 | M2 accepted | $70,000 | $138,000 |
| 4 | M3 accepted | $40,000 | $178,000 |
| 5 | M5 accepted (audits published, mainnet-beta live) | $70,000 | $248,000 |

Tranches are timed to milestones, not equal to their engineering cost:
the grant pays the audits, the operator programme, infrastructure, legal
and contingency in full, plus $47,000 of engineering, with the audit share
released at M5 when the reports are public. M4's acceptance is reported
like the others even though its engineering is funded outside the grant.

---

## 6. Why this is a public good, and why Solana

- **Open source, MIT.** Program, node, SDK and operator kit are public today and stay public. Audits are published in the repo.
- **A primitive, not a product.** Any wallet, DAO or program on Solana can give its users addresses on other chains without a bridge or a custodian. Every integration is a line in a registry, not a partnership with us.
- **Solana-specific by construction.** The on-chain derivation uses Solana's `secp256k1_recover` syscall; the authorisation model is Solana accounts and PDAs; program-owned foreign addresses are a CPI. None of it ports to another host chain.
- **Learnings shared.** The derivation trick, the multi-provider observation model and the operator kit are documented as design notes for anyone building threshold services on Solana.

---

## 7. Funding split

| Source | Amount | Covers |
|---|---|---|
| Solana Foundation grant (this proposal) | $248,000 | Audits $105,000; operator programme $30,000; infrastructure $31,000; legal $10,000; contingency $25,000; engineering $47,000 |
| Superteam Malaysia support | $30,000 | Engineering (SDK and adapters, M4) |
| Sui Foundation adapter grant (applied) | $40,000 | Engineering (Sui adapter and DeepBook reference app, M4) |
| Founder contribution (below-market rate) | $111,000 | Engineering (lead engineer across all milestones, Rust engineer share) |
| **Total** | **$429,000** | Engineering $228,000 + non-engineering $201,000 |

If the Foundation prefers a convertible grant for the commercial layers
(institutional plan, gas relayer), we are open to that structure for
M5's mainnet-beta portion.

---

## 8. Lean option — $168,000

If the Foundation wants a smaller first commitment, this delivers an
audited 2-of-3 committee with three attested operators in 6 months.
Scope changes from the full plan:

- 2-of-3 only, three operators instead of five.
- Bitcoin adapter deferred; M4 shrinks to packaging and the CPI crate.
- One combined audit covering program and integration ($70,000); TEE review deferred to a follow-on.
- Rust engineer for 6 months instead of 8.

| Grant tranche | On completion of | Amount |
|---|---|---|
| 1 | Approval | $20,000 |
| 2 | M1 hardening and fee hook | $28,000 |
| 3 | M2 committee at 2-of-3 | $50,000 |
| 4 | M3 attested operators (3) | $30,000 |
| 5 | M5 audit published and mainnet-beta live | $40,000 |
| **Total grant** | | **$168,000** |

Covers: the combined audit $70,000, three operator stipends for 12 months
$14,400, infrastructure $20,000, legal $10,000, contingency $15,000, and
$38,600 of engineering. Remaining engineering is founder-funded as above.

The lean option gets to "no single party can sign" and "operators cannot
read the key", which are the two properties integrators ask about first.
It does not get to Bitcoin or a five-operator set.

---

## 8b. Starter option — $50,000

One outcome, four months: **replace the 2-of-2 under one operator with a
2-of-3 committee run by three independent operators on devnet**, built on
the audited threshold crate so the later milestones extend it rather than
replace it. This is the single change that turns SODA from a demo into
something a wallet team can evaluate.

Not included, stated plainly: no audit, no TEE attestation, no Bitcoin
adapter, no mainnet. Each of those is a follow-on milestone from the full
plan and none of them is worth starting before the committee exists.

### Scope

**S1 · Hardening — month 1 — $6,000**

- Expiry enforced in `finalize_signature`; `fee_bps` hook shipped at zero;
  `chain_tag` added to `SigRequest` seeds.
- CI on a public runner: Rust tests, TypeScript tests, IDL drift check,
  golden derivation vectors shared by Rust and TypeScript.

Acceptance: CI green; expiry and fee covered by program tests.

**S2 · 2-of-3 committee — months 1–3 — $35,000**

- Rust node on NEAR's `threshold-signatures` crate: PedPop+ DKG, triple and
  presignature pool, additive derivation folded into the presignature, one
  online signing round.
- Node essentials only: Solana observation through two independent RPC
  providers that must agree before signing; RocksDB store with
  one-time-material consumption markers; mTLS between peers;
  `finalize_signature` submitter.
- On-chain: `Committee` gains a participant list and threshold; the live
  committee key is rotated to the new DKG output with `update_committee`.

Acceptance: 2-of-3 committee on devnet, three operators in three regions
on three providers; every existing demo (Aave, DeepBook, vault) re-run
through it; one operator taken offline mid-run with signing continuing.

**S3 · Operators live — month 4 — $4,000**

- Operator kit: one container, health and metrics endpoints, a one-page
  onboarding guide.
- Three operators recruited through Superteam Malaysia and Solana
  validators, running for 30 days at 99% uptime.

Acceptance: 30-day uptime report published; operators named in the repo.

### Budget

| Item | Cost |
|---|---|
| Rust / MPC engineer, 3 months at $13,000 | $39,000 |
| Operator stipends, 3 × $200 × 6 months | $3,600 |
| Infrastructure: RPC plans for team and operators, devnet deploys | $2,400 |
| Contingency | $5,000 |
| **Total** | **$50,000** |

Lead engineering, integration, CI and documentation are founder time,
contributed in kind (about $18,000 at the full plan's rate).

### Tranches

| Tranche | On completion of | Amount |
|---|---|---|
| 1 | Approval | $10,000 |
| 2 | S1 accepted | $6,000 |
| 3 | S2 accepted | $28,000 |
| 4 | S3 accepted | $6,000 |

### What it sets up

Everything in the full plan builds on this node: TEE attestation wraps the
same container (M3), the audit scopes the same code (M5), and moving from
2-of-3 to 3-of-5 is a resharing, not a rewrite. If the starter option is
funded first, the remaining ask for the full plan drops to $198,000.

---

## 9. Risks and what we do about them

| Risk | Mitigation |
|---|---|
| Threshold crate integration takes longer than planned | The crate is production code with published docs and an audited API; M2 has the largest buffer, and the 2-of-3 launch target does not depend on the 3-of-5 stretch |
| Operators do not sign up | Stipends remove cost as a reason; the Foundation's introductions to validators are the single most valuable non-cash contribution it can make |
| Audit quotes exceed estimates | Contingency covers up to a 25% overrun; scope can drop the TEE review to a follow-on |
| Solana observation trust (no light client) | Multi-provider k-of-n agreement designed in at M2; documented as a known limitation until a Solana light client exists |
| Key-management incident before mainnet | TVL cap per epoch at mainnet-beta; resharing tested at M2; incident runbooks at M3 |

---

## 10. Reporting

Monthly written update in the public repo (`docs/updates/`), each milestone
closed with a reproducible acceptance run and the addresses or reports it
produced. The Foundation can verify every milestone from public state.
