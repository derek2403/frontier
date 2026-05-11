# SODA


> **Solana-Owned Derived Authority.**
> A Solana program just spent a Bitcoin UTXO.
> No wrapped tokens. No bridge. No custodian.
> A primitive for Solana programs to control native external-chain assets through derived authority.

### The diff vs everything it isn't

- **Technical:** One CPI call from any Anchor program returns a valid signature on any ECDSA chain. A Solana PDA *is* the owner of the BTC.
- **vs Phantom / MetaMask:** Phantom is a wallet for people. SODA is a wallet for smart contracts. A contract can't click Sign.
- **vs Zeus / zBTC:** Zeus is USDC. SODA is ERC-20. (One wrapped product vs the primitive underneath every wrapped product.)
- **vs Ika:** Ika = wallets that touch every chain. SODA = programs that own every chain.
- **vs Wormhole / LayerZero / deBridge:** Bridges pass messages. SODA passes authority. Bitcoin never learns Solana exists.

SODA is an Anchor program + off-chain MPC committee that exposes cross-chain signing as a **CPI primitive**. Any Solana program calls `soda::request_signature(path, payload, chain)` and receives a valid secp256k1 signature on Bitcoin, Ethereum, or any other ECDSA chain. The foreign-chain address is deterministically derived from the caller's `(program_id, seeds)`, so a Solana PDA literally owns the UTXO.

---

## 1. The problem

Solana has no native way to act on other chains.

Today, every Solana protocol that wants to touch Bitcoin, Ethereum, or any non-Solana asset has exactly three options — all broken:

| Option | Problem |
|---|---|
| **Wrapped tokens** (wBTC, cbBTC) | Custodial. BitGo or Coinbase holds the real BTC. One subpoena, one exploit, one policy decision — the peg breaks. |
| **Bridges** (Wormhole, LayerZero, deBridge) | Message-layer only. They don't give a Solana program *authority* over a foreign asset — they just pass notes. And they get hacked. A lot. |
| **Users signing on every chain** | Breaks autonomy. An AI agent, a vault strategy, a scheduled rebalance — none of these can sign an Ethereum tx at 3am without a human holding the key. |

**The gap:** no Solana program today can hold its own private key on another chain. That single missing primitive is why Solana DeFi stops at the Solana edge.

### The damage so far

| Metric | Value | Source |
|---|---|---|
| Total lost in bridge hacks | **$3.8B+** | Rekt.news leaderboard (Ronin $625M, Poly $611M, BNB $570M, Wormhole $321M, Nomad $190M, Harmony $100M…) |
| wBTC custodial float | **~$10B+** | DefiLlama — held by BitGo, one entity |
| wBTC share of wrapped-BTC supply | **~62%** | Galaxy Research Q4 2025 |
| Bitcoin sitting idle, unable to touch Solana DeFi | **$1.3T+** market cap | CoinMarketCap |

Every one of those numbers is a dollar figure trapped by the same missing primitive.

---

## 2. The solution

**SODA is that primitive.**

Any Anchor program makes one CPI call:

```rust
soda::request_signature(
    derivation_path,        // arbitrary per-request path
    payload_hash,           // 32-byte message to sign
    target_chain,           // BTC, ETH, any ECDSA chain
)
```

Within ~5 seconds, a `SigCompleted` event fires with a valid secp256k1 signature usable directly in a Bitcoin or Ethereum transaction.

### How it works under the hood

1. **Derivation.** A Solana PDA's foreign-chain public key is computed deterministically:
   `foreign_pk = group_pk + H(program_id ‖ seeds ‖ chain_tag) · G`
   The same PDA always controls the same BTC address. No registration, no mapping table.

2. **Threshold signing.** A committee of MPC nodes runs **FROST-secp256k1** (Zcash Foundation, single-round, BSD-licensed). Each node holds one FROST share; t-of-n shares produce a valid signature.

3. **On-chain aggregation.** Shares are submitted as Solana transactions, aggregated inside the `soda` program, and verified via the native `secp256k1_recover` syscall (~25,000 CU).

4. **Economic security (post-MVP).** Committee membership is gated by SOL restaked through Solayer/Cambrian. Failing to sign → slashing. Signing a request the program didn't emit → slashing.

The result: a Solana PDA is, cryptographically, the owner of the foreign UTXO or account. No wrapper, no bridge message, no custodian in the path.

---

## 3. Why this beats every bridge

Near proved the primitive works. Solana's runtime (syscalls, PDAs, CPI, restaking) is actually a cleaner host for it. SODA isn't "Near ChainSig on Solana" — it's the same idea on a more composable substrate.

| Benefit | Why it's better than a bridge |
|---|---|
| **Real ownership of native assets** | BTC lives in the UTXO set, not locked in a contract IOU. A Solana PDA *is* the owner. |
| **Per-user / per-vault derived addresses** | Every `(program_id, seeds)` pair maps to a unique foreign address. No address reuse. Privacy by default. |
| **Program-gated signing logic** | "Sign this BTC spend only if the Drift position is flat" — expressible in Anchor, enforced on-chain. Bridges have no access to this logic. |
| **No honeypot** | There is no TVL-holding bridge contract to hack. The "bridge" is a signature primitive, not a locked vault. |
| **Agent-native** | An AI agent deployed as a Solana program gets its own BTC and ETH identity. No Turnkey, no Privy, no SaaS custody. |
| **Composable in one tx** | Swap on Jupiter + hedge on Hyperliquid + pay a Bitcoin invoice — one Solana transaction, one slot, atomic. Bridges cannot do this. |

---

## 3.5 What "bridge" actually means, and why SODA isn't one

Everyone lumps every cross-chain product into "bridge." Useful to separate what real bridges actually do — because the two hack categories SODA eliminates map directly onto these two layers.

### Layer 1 — Token bridge (asset wrapping)
Moves a real asset from chain A as an **IOU** on chain B.
- You send real BTC to a custodian or smart contract on Bitcoin.
- An IOU (`wBTC`) gets minted on Ethereum/Solana.
- The real BTC is **locked in a central vault**.
- Redeem = burn the IOU, vault releases the real BTC.

Examples: wBTC (BitGo holds the BTC), Portal (Wormhole holds it), tBTC (Threshold custody).

**Hack vector:** compromise the vault → mint fake IOUs OR drain the real locked assets.

### Layer 2 — Message bridge (data relay)
Just sends a message from chain A to chain B. Doesn't have to be about tokens.
- Chain A: "user X did Y"
- Validators sign off: "yes that really happened"
- Chain B: "OK, I believe it, executing..."

Examples: LayerZero, Axelar GMP, Wormhole Core Messaging.

**Hack vector:** forge the validator signatures → chain B believes lies → mint/unlock/drain.
- **Ronin ($625M):** 5-of-9 validator keys stolen → forged "release all funds" messages
- **Wormhole ($321M):** signature-check bug let attacker forge messages without stealing keys

### How they stack
Modern token bridges = message bridge + lock/mint contracts glued together.
- LayerZero = pure message layer
- Stargate = token bridge built on top of LayerZero
- Hack LayerZero once = every token bridge using it drains

Headline "bridge hacked for $X" is almost always: message layer compromised → token layer drained as a consequence.

### Where SODA sits — neither layer
SODA does **not** move tokens. SODA does **not** relay messages.

SODA is a **signature service**:
1. Solana program asks: "please sign this Bitcoin transaction."
2. MPC committee produces a valid secp256k1 signature.
3. The signature is used on Bitcoin directly — **Bitcoin doesn't know Solana exists**.

From Bitcoin's view: a normal Bitcoin address just spent its UTXO. Same as if a human with a Ledger signed it.

**One-liner:**
> Bridge = "lock assets on A, mint IOU on B" (token layer) + "A says X, B believes X via validators" (message layer). Both have central attack points. SODA = "program asks MPC to sign; foreign chain executes like any normal tx." Not a bridge — a signing service that happens to work on any chain.

---

## 3.6 How SODA eliminates both hack classes

### Layer 1 — the pooled vault honeypot

**Bridge problem:** all users' BTC pooled in ONE vault. One hack = $625M gone (Ronin).

**SODA's answer: there is no vault.**

Each `(program_id, seeds)` pair maps to its OWN derived Bitcoin address. If 10,000 Solana programs use SODA, that's 10,000 different Bitcoin addresses — each with its own BTC balance, each signed-for by its own derivation path.

| | Ronin-style bridge | SODA |
|---|---|---|
| Where the BTC sits | 1 central vault contract/multisig | N scattered derived addresses |
| Exploit ROI | Compromise one set of keys → drain everything | Compromise MPC **and** trick each owning program, one by one |
| "Drain all" button | Exists (single tx can drain the vault) | Doesn't exist — no single target |

Even in the worst case — full MPC committee compromise — the attacker can only sign transactions for addresses where they also get a legitimate `SigRequested` event from the owning Solana program. Ronin-scale heists are structurally impossible because there's no Ronin-scale target.

**Fresh Solana evidence (April 2026):** The Drift exploit drained $4.4M of wBTC and $590K of zBTC in a single incident — not hypothetical, not another chain, not last cycle. Wrapped-BTC on Solana is an active exposure right now. Every protocol holding wrapped tokens in a single vault shares Drift's attack surface.

### Layer 2 — forged message attestation

**Bridge problem:** chain B needs to believe "chain A did X." Forge the attestation → chain B believes lies → drain.

**SODA's answer: no cross-chain message ever exists.**

End-to-end flow:
1. Solana program emits `SigRequested` event **on Solana**.
2. MPC nodes read the Solana event directly — they subscribe to Solana RPC like any other client. No bridge involved.
3. MPC nodes submit FROST shares **back to Solana** via normal Solana transactions.
4. SODA program aggregates shares, emits `SigCompleted` with a raw Bitcoin signature.
5. Anyone (client, relayer, user's browser) broadcasts that signature + tx to Bitcoin.
6. Bitcoin verifies the signature the same way it verifies any signature.

**Bitcoin never receives a "Solana said so" message.** Bitcoin has no interface for cross-chain claims. It just checks: is this signature cryptographically valid for this pubkey and this message? Math says yes or no.

| Bridge attack vector | Exists in SODA? |
|---|---|
| Bribe validators to sign a false attestation | ❌ No validators relay anything |
| Compromise cross-chain multisig | ❌ No cross-chain multisig exists |
| Replay a valid message | ❌ No messages |
| Exploit a proof-verification contract on chain B | ❌ No proof posted to Bitcoin |
| Signature-check bypass (Wormhole $321M) | ❌ No "verify Solana said so" code path |

The only way to forge a SODA output is to break secp256k1 itself — which would break Bitcoin too. **SODA's trust assumption is a strict subset of Bitcoin's own trust assumption.**

### Why this is structural, not "hardened"
Most bridges patch hacks with better validator sets, more signatures, light clients, ZK proofs of events. Each is a defense against the same attack class — forging an attestation.

SODA **removes the attestation entirely**. Not a more secure bridge — not a bridge. Bitcoin can't tell the difference between a signature from SODA's MPC committee, a user's Ledger, or Satoshi in 2010. The attestation problem doesn't exist because the attestation doesn't exist.

**One-liner:**
> Layer 1 (vault hack) disappears because SODA has no vault — every user/program gets its own derived address.
> Layer 2 (forged attestation) disappears because SODA sends no cross-chain message — Bitcoin just sees a valid signature.
>
> The two biggest bridge hack classes aren't *mitigated*. They're *structurally impossible*.

---

## 4. What this unlocks — concrete scenarios

These are products that **cannot be built today** on Solana without SODA. Each becomes a one-CPI-call integration once SODA ships.

### 4.1 Autonomous vault hedges on Hyperliquid at 3am
A Solana vault runs a delta-neutral strategy: holds SOL long, needs to hedge with a short ETH perp on Hyperliquid. Price spikes at 3am.

- **Today:** either a human wakes up and signs, or a Turnkey/Privy-held key signs on the vault's behalf (custodial).
- **With SODA:** the vault program CPIs into `soda::request_signature`, gets back an Ethereum-signed tx authorizing the Hyperliquid short. Zero humans. Zero third-party custodians. The Solana PDA *is* the Hyperliquid account.

### 4.2 AI agent with its own BTC and ETH identity
An agent deployed as a Solana program — the agent's on-chain account *is* its identity — can hold BTC, ETH, and SOL simultaneously. The same `program_id + seeds` maps to:
- a Solana PDA
- a Bitcoin P2WPKH address
- an Ethereum EOA-equivalent

The agent cross-chain arbs, signs, settles, and rebalances without any custodial rail. The entire "AI agents control money" narrative (Plutus, AgentRunner, MCPay) assumes Turnkey/Privy under the hood. SODA removes that assumption.

### 4.3 Third-party non-custodial zBTC clone
Anyone can ship their own wrapped-BTC product using SODA as the primitive:
- Deposit: user sends BTC to a derived address owned by a Solana PDA.
- Mint: program mints a wrapped receipt (spl-token) 1:1.
- Redeem: redemption burns the receipt, program CPIs SODA to sign a BTC spend back to the user.

No BitGo. No subpoena risk. No "the custodian froze our peg" incident. Zeus ships one of these; SODA lets anyone ship one.

### 4.4 Composable in one transaction
A single Solana tx containing: swap SOL→USDC on Jupiter, short-hedge via SODA-signed ETH perp on Hyperliquid, pay a Bitcoin invoice via SODA-signed BTC spend. One slot. Atomic. Reverts as a unit if any leg fails.

Bridges fundamentally cannot compose this way (multi-tx, multi-chain finality). This is the structural win of signature-layer over message-layer.

### 4.5 MEV searcher, cross-chain
A Solana searcher program detects a pricing dislocation between a Solana DEX and an Ethereum DEX. It atomically builds both legs: buys on Solana, sells on Ethereum via SODA-signed tx. No LayerZero round-trip, no LP on a bridge — just a program signing on both chains in the same workflow.

### 4.6 Why this kills the wrapped-BTC model on Solana

#### The Solana BTC market today — and why it's custodial

Solana DeFi (Kamino, MarginFi, Drift, Jupiter, Meteora, Raydium, Phoenix, Jito) needs to accept BTC as collateral, hedge leg, and settlement asset. Three products currently fill that demand — all custodial or closed-federation:

| Product on Solana | Live TVL | Trust model | Who holds the BTC |
|---|---|---|---|
| **cbBTC** | ~$6.3B global (dominant on Solana, integrated with every major DeFi venue) | Coinbase custody | Coinbase Corp. |
| **wBTC** (via Portal / Hyperlane to Solana) | Billions global, smaller share on Solana | BitGo custody + Wormhole/Hyperlane validators | BitGo Trust + bridge validator set |
| **zBTC** (Zeus Network) | ~$14M (~210 BTC, +240% YoY but small base) | Closed Guardian MPC federation | ~5 team-selected Guardian nodes |

Every one of these exists for the same reason: **no Solana program could hold a real Bitcoin private key**. A custodian (or a closed federation) was the workaround.

#### SODA removes the reason for the workaround

A Solana lending protocol can own real BTC directly at a derived Bitcoin address. No wrapping, no custodian, no closed federation.

| Step | Today (cbBTC / wBTC / zBTC flow) | With SODA |
|---|---|---|
| Deposit | User sends BTC to Coinbase / BitGo / Zeus Guardian address | User sends BTC to `(lending_protocol_id, user_id)` derived Bitcoin address |
| On Solana | Custodian mints 1 wrapped token to user | Protocol reads Bitcoin chain, credits user 1 BTC internally — **no token minted** |
| Collateral | Wrapped token sits in the lending vault | Real BTC sits at the derived Bitcoin address |
| Redeem | Burn wrapped token → custodian releases BTC | Protocol CPIs SODA → signs BTC tx → user gets real BTC |
| Who holds the BTC | Coinbase (cbBTC) / BitGo (wBTC) / Zeus (zBTC). One entity / one closed set. | N program-derived addresses. No central custodian. |
| Trust | Custodian stays solvent, honest, not sanctioned | FROST math + slashable restaked committee |

#### Three reasons this kills the wrapped-BTC moat on Solana

1. **No custodian.** cbBTC's existence depends on trusting Coinbase. wBTC depends on BitGo. zBTC depends on Zeus's 5-Guardian federation. SODA has no custodian. For a new Solana DeFi protocol, "launch on SODA" is strictly lower-trust than "integrate cbBTC."

2. **Provable backing on-chain.** Coinbase/BitGo/Zeus publish attestations saying "we hold $X of BTC." You trust the attestation. With SODA, the BTC sits at deterministic addresses — anyone opens mempool.space and confirms backing directly. Zero trust in an issuer.

3. **No IOU to depeg.** cbBTC, wBTC, zBTC are all wrapped tokens that can depeg from their underlying (cbETH depegged 7% post-FTX, USDC depegged 13% during SVB, wBTC paused during the Justin Sun episode). Any custodial wrapper can break. SODA has no wrapped token — backed 1:1 by BTC it literally signs for.

#### Why this doesn't kill them overnight — but bleeds them out
cbBTC alone is ~$6.3B globally with deep Solana integrations. wBTC and zBTC add to that. None disappear in a week. But:

- **New protocols launch native.** Every lending/DEX/vault shipped after SODA prefers native BTC. Wrapped products stop gaining share.
- **Old protocols offer both.** Kamino, MarginFi et al. add native-BTC markets alongside cbBTC ones. Sophisticated users migrate.
- **The next incident accelerates.** Drift's April 2026 exploit stole **$4.4M wBTC + $590K zBTC** from a single venue in a single event — fresh, Solana-specific proof that wrapped-BTC on Solana is a live exposure. One more incident at scale and "there was a non-custodial alternative all along" collapses share the way Frax/DAI pulled share from algo-stables after LUNA.

**One-liner:**
> cbBTC is a workaround for "smart contracts can't hold BTC." zBTC is the same workaround with a smaller federation. SODA makes smart contracts hold BTC. Once the primitive ships, the workaround has no reason to exist — and the $6B+ of custodial BTC sitting on Solana starts looking for a non-custodial home.

---

## 4.7. Could this have prevented the Drift-class attack?

Short answer: not directly — SODA is a cross-chain signing primitive, not a wallet, and Drift was a Solana-local issue. But SODA ships the architectural pattern that makes "one compromised key drains everything" impossible by construction.

**What broke at Drift.** A single key with unilateral spend authority got compromised (durable-nonce reuse). One signature, full drain, no recourse. Classic "key in → funds out" design.

**Why SODA's architecture is the fix class:**

| Property | Traditional wallet | SODA model |
|---|---|---|
| Signing authority | One private key | Threshold of committee shares |
| Address ownership | User keypair | Program PDA |
| Spend path | Raw signature | CPI call through program |
| Policy enforcement | Off-chain trust | On-chain rules (caps, TTL, allow-list) |
| Single-point compromise | Drains everything | Signs nothing alone |

No single key exists on the signing side. The foreign-chain address is owned by a program PDA, not a user keypair — spending requires a CPI call, not a raw signature. Every request flows through a program that can layer caps, TTLs, allow-lists, and anomaly freezes on top of the cryptographic threshold.

**Port this back to Solana-local wallets** — vault is a PDA, every spend is a gated CPI, authority is split across MPC committee + program policy — and durable-nonce-style single-key exploits lose their target. There is no single-key-holding account to compromise.

**The honest framing:**
> SODA itself won't save Drift's vault. But it ships the primitive pattern that — generalized into wallets — would. The cryptographic threshold + program-policy design is what "unilateral compromise is impossible" looks like as code.

---

## 5. Why now

Four tailwinds converge in Q1 2026:

- **ICM narrative** — Multicoin, Solana Foundation, Galaxy all publicly arguing Solana should be the venue for every asset (BTC, RWAs, equities). That thesis requires cross-chain authority, which doesn't exist today.
- **Hyperliquid pressure** — Solana perps / treasury teams are losing mindshare to Hyperliquid. Hedging a Solana vault on a foreign venue without giving up custody is the missing capability; SODA supplies it.
- **Agent economy** — Every AI-agent framework on Solana (AgentRunner, Plutus, MCPay) assumes the agent trusts Turnkey/Privy/a SaaS custodian for non-Solana chains. SODA removes that dependency.
- **Colosseum RFPs** — "Trading Tools For Whales" and "Plugging Payments Into The Internet" (both official Colosseum Request For Products) structurally require what SODA delivers.
- **Frontier hackathon scale** — 11,000+ registered devs across 100+ countries this cycle. The primitive that unlocks cross-chain programmability for even 1% of them is a distribution event, not a solo product launch.

---

## 6. Market sizing

| Layer | TAM indicator |
|---|---|
| **Bridge market** (the market SODA displaces) | ~$15B TVL across bridges, declining post-hacks |
| **cbBTC** (dominant wrapped-BTC on Solana, direct displacement target) | **~$6.3B global** market cap, integrated with Jupiter/Meteora/Kamino/Raydium/Phoenix/Jito/Drift |
| **wBTC** (secondary wrapped-BTC, on Solana via Portal/Hyperlane) | Billions global; smaller share on Solana |
| **zBTC** (Zeus Network, closed-federation wrapped-BTC on Solana) | **~$14M** (~210 BTC, +240% YoY — validates demand, exposes the federation scaling ceiling) |
| **Drift April 2026 incident** (fresh wrapped-BTC loss, Solana-specific) | **$4.4M wBTC + $590K zBTC** drained in one event |
| **Circle USDC minted on Solana** (proof Solana is the settlement venue) | **$2.25B in a single week** — the rail the ICM thesis rests on |
| **Near Chain Signatures volume** (proof of demand on another chain) | $500M+ signed tx volume, 2025 |
| **Solana DEX daily volume** (downstream consumers of SODA hedging flows) | $3.5B–$6B, DefiLlama |
| **Jupiter monthly volume** (single potential CPI integrator) | ~$60B/mo |
| **Cubist / Lombard BTC under programmatic signing** (SaaS incumbent in this exact category) | **$2B** — proves enterprise demand; SODA is the decentralized version |

SODA is an infrastructure primitive, not a product. It takes a cut — or a fixed-fee — of every cross-chain action taken by every integrating protocol. The business model is the same as Wormhole's, with a strictly larger surface area (signatures ⊃ messages).

**What these numbers say together:** $6.3B of cbBTC proves the demand for programmatic BTC on Solana is real and settled. zBTC at only $14M after 18 months of the closed-federation model proves the current non-Coinbase alternative doesn't scale. The Drift April 2026 event proves the custodial/closed-federation exposure is active, not theoretical. SODA's wedge: the non-custodial primitive underneath everything cbBTC and zBTC do — without Coinbase, without a closed Guardian set, without a single corporate-custody honeypot.

---

## 7. Competitive landscape

Validated against the Colosseum Copilot project database (**5,400 hackathon projects** across Renaissance, Radar, Breakout, Cypherpunk) and archive corpus (Helius, Galaxy, Alliance, Paradigm, Solana Foundation blogs).

### Direct-competitor scan: nobody is doing this

| Query (against 5,400-project corpus) | Max similarity score |
|---|---|
| "Solana program signs Bitcoin via MPC" | **0.060** |
| "FROST ECDSA secp256k1 Solana PDA cross-chain" | **0.058** |
| "Solana program controls native Bitcoin UTXO" | No match > 0.06 |

**Threshold for a real match in Copilot = ~0.10.** SODA sits below the noise floor. Structurally uncontested.

### Who's adjacent — and how we're different

| Competitor | What they ship | Why they don't cover SODA |
|---|---|---|
| **btcport** (Renaissance 2024, unprized) | BTC-only MPC relayer, 2-person team | BTC only, no CPI exposure, no general curve, no prize. Closest on the board and still a completely different product. |
| **Zeus Network** (commercial, Anatoly is angel) | `zBTC` — one wrapped-BTC product backed by their Guardian MPC | Zeus is one product. Their MPC is private. SODA is the primitive Zeus never released — anyone could build their own zBTC on top of us, plus autonomous vaults and agents Zeus's custodial flow cannot ship. **Think: Zeus is USDC, SODA is ERC-20.** |
| **Solv Protocol** (becoming Zeus's first "Institutional Guardian", $2.2B TVL, 1.13M users) | Adds a credentialed institution to Zeus's Guardian federation | Reinforces Zeus's moat short-term but doesn't change the category — a 5-Guardian federation with Solv as one of them is still a 5-Guardian federation. SODA at maturity is 100+ permissionless restakers with slashable bond. Solv is a brand upgrade to Zeus's trust; SODA is a different trust model entirely. |
| **ZetaChain** (universal app chain, added Solana support 2026) | Build your app on ZetaChain, which talks to Solana + BTC + ETH natively | Different substrate choice. A Solana-first dev CPIs into SODA from their existing Anchor program; porting to ZetaChain requires abandoning Solana as the execution layer. Confirms demand for programmable cross-chain signing; loses to SODA for Solana-native builders. |
| **Cubist CubeSigner** (enterprise SaaS, secures Lombard's $2B BTC) | Centralized programmatic key signing for institutions | Proves "programmatic cross-chain signing" is a $2B+ enterprise category. Cubist is SaaS, hosted, closed. SODA is the on-chain, permissionless, CPI-native version — same market, different trust model. Cubist customers who care about decentralization migrate; ones who don't stay. |
| **Ika** (Sui-origin, Solana port announced March 2026) | 2PC-MPC — *user* holds one share, network holds one share | Their architecture **requires a user share on every signature** → consumer-wallet only. A Solana PDA can't hold a user share. SODA is program-autonomous; Ika is user-in-the-loop. *Ika = wallets that touch every chain. SODA = programs that own every chain.* |
| **Squads** | Team-multisig on Solana | Not cross-chain. Different category. |
| **Wormhole / deBridge / LayerZero** | Messaging bridges | Message-layer, not signature-layer. They pass notes; SODA delegates authority. |

### Signal from Colosseum winners list

No winner in any Colosseum hackathon (Renaissance 2024 → Cypherpunk 2025) occupies the "programmatic cross-chain signing as a primitive" slot. Adjacent infra prizes (Seer $25k, Flux-RPC $25k, Cambrian $20k, Shiroi $5k) prove Infrastructure judges reward genuine primitives — which is exactly SODA's category.

---

## 8. "But isn't this just Phantom / MetaMask?"

The single most common objection. The answer is no — and the precise reason why is the whole product.

### The derivation math is the same family
Both Phantom/MetaMask (BIP32) and SODA use the same shape of derivation:
> `new_public_key = parent_public_key + hash(stuff) · G`

Structurally identical additive key derivation. Same math. That's actually a strength — it proves the cryptography is sound (BIP32 has secured trillions in crypto over a decade).

### What's different — the hash inputs

| | Phantom / MetaMask (BIP32) | SODA (ChainSig-style) |
|---|---|---|
| Hash input | `chain_code ‖ parent_pubkey ‖ index_number` | `program_id ‖ seeds ‖ chain_tag` |
| What identifies a child key | An index number (`m/44'/0'/0'/0/0`) | A Solana program's on-chain identity |

### What's different — where the parent key lives

| | Phantom / MetaMask | SODA |
|---|---|---|
| Parent private key | One piece — your seed phrase, in your head | Doesn't exist as one piece. Split into FROST shares across MPC nodes. |
| To sign, you need | The seed → derive child key → click Sign | t-of-n MPC nodes to cooperate when the Solana program emits a request event |
| Who can be the owner | Only humans (a seed has to live in a brain or a device) | Any Solana program, DAO, vault, or AI agent |

### Why this subtle difference IS the product

BIP32's parent has to come together as a single seed, somewhere, to sign. That "somewhere" is always a human. You can't ask a DAO "what's your seed phrase?" — a DAO has no head.

SODA's parent never comes together. No one holds the master key — not you, not the committee, not any single MPC node. Shares only combine when the Solana program emits a `SigRequested` event. The authority is on-chain code, not a human-held seed.

### Rebuttals ready-to-use

**"Can a DAO use Phantom?"**
No — a DAO is code. Phantom needs a seed phrase in someone's head. With SODA, the DAO's own program is the signer. The DAO holds BTC directly.

**"Can a vault auto-hedge on Hyperliquid at 3am?"**
Not with Phantom — it needs a human click. With SODA, the vault program CPIs and signs the Ethereum tx itself. No humans awake.

**"Can an AI agent sign cross-chain?"**
Not without a custodian (Turnkey, Privy, Fireblocks) — those services hold the seed for the agent. With SODA, the agent's Solana program is the signer. No SaaS in the middle.

### One-line knockout

> **"Phantom is a wallet for people. SODA is a wallet for smart contracts. A contract can't click Sign."**

Same derivation math. Phantom's root is a seed in your head; SODA's root is code on Solana. That's the whole product in one sentence.

### 8.5 FAQ — do I still need a bridge between my own SODA wallets?

Most common follow-up after the Phantom one. **Answer: no. SODA doesn't move assets between chains. Ever.**

If your Solana program owns wallet A (BTC on Bitcoin) and wallet B (ETH on Ethereum):
- Wallet A is a real Bitcoin address holding real BTC on **Bitcoin**.
- Wallet B is a real Ethereum address holding real ETH on **Ethereum**.
- These are **two separate holdings on two separate chains**. They never touch.
- SODA just lets your Solana program sign for either one.

No bridge happens between A and B. They coexist, owned by the same program. Like one person having a Chase account AND a HSBC account — they don't need a "bridge" between them. Just two accounts.

#### "But what if I want to turn my BTC into ETH?"

Then you **trade**. Trade ≠ bridge.

| | Bridge (wBTC / Wormhole) | Swap (SODA + DEX) |
|---|---|---|
| What happens | BTC locked in bridge vault. IOU (wBTC) minted on other chain. | BTC sold on Bitcoin DEX (Thorchain, Maya) for stablecoin. Real BTC goes to buyer. Program buys ETH on Uniswap with stablecoin. |
| Your real BTC | Locked in central vault forever (until redeem) | Gone — you sold it. Buyer has it. |
| Central honeypot? | Yes — vault holds all users' BTC | No — DEX matches orders atomically, no pool |
| Hack risk | Ronin, Wormhole, Nomad — $3.8B category | Market risk (slippage) only — no "drain everyone" event |

Swap still has **market** risk, but not **bridge** risk. Different category entirely.

#### But usually you don't even want to convert

The killer use case isn't "turn BTC into ETH." It's holding positions on multiple chains simultaneously, without the assets ever moving between chains.

- **AI agent:** BTC address for payments + ETH address for gas + SOL account for logic. All three sit on their own chain. Nothing bridges. The agent's Solana program signs for each when needed.
- **DAO treasury:** 100 BTC on Bitcoin + 1000 ETH on Ethereum + 50k SOL on Solana. Each holding grows/shrinks on its own chain via trades, yield, payments. Nothing ever bridges.
- **Delta-neutral vault:** Long 100 SOL on Solana (spot) + short SOL perp on Hyperliquid (margin sourced natively on Ethereum). No BTC→ETH conversion needed — just coordinated positions on three chains.

**One-liner:**
> Wallet A (BTC) going "to" wallet B (ETH) via SODA is not a thing — they're independent holdings, not two ends of a pipe. If you want to convert, that's a trade on a DEX (market risk, not bridge risk). The whole point of SODA: your Solana program can own native assets on many chains at the same time, without anything ever being bridged.

---

## 9. Who's saying this matters

| Source | Signal | Date |
|---|---|---|
| **Anatoly Yakovenko** — angel investor in Zeus Network alongside Mechanism Capital and Muneeb Ali | Anatoly personally bet on "Bitcoin-on-Solana" as a wedge. SODA is the primitive layer that thesis needs. | Mar 12 2024, CryptoSlate |
| **Galaxy Research, Q4 2025** | Flagged ICM + programmatic cross-chain authority as the 2026 wave; highlighted wBTC's 62% custodial concentration as a structural risk | Q4 2025 |
| **Alliance Essays — "The Bitcoin L2 Opportunity"** | Mapped BitVM + MPC-custody paths for bringing BTC on-chain; SODA is the Solana-native implementation | Mid-2025 |
| **Colosseum Codex — "BitcoinKit" feature** | Colosseum's own editorial team elevated Bitcoin-on-Solana as a hackathon category | 2025 |
| **Near Foundation — Chain Signatures retrospective** | "Primary user-acquisition flywheel" — $500M+ signed tx volume | Q4 2024 |
| **Helius — Dean Little, "Bitcoin on Solana"** | Technical survey calling out the gap SODA fills | 2025 |

---

## 10. The pitch

### Three angles, one sequence

Three one-liners, each landing a different beat. We deliver them in the order **B → A → C** — open with Solana-gravitation (investor alignment), pivot to the missing-primitive (judges' technical novelty bar), close with dollar figures (why-now urgency). Avoids Ika's "bridgeless" tagline and sidesteps the "bridge category" judge-trap.

**Frame B — Solana gravitation** (open here):
> "SODA makes Solana the venue where every asset on every chain is owned by a program. BTC, ETH, any secp256k1 key — becomes a Solana-controlled object."

**Frame A — Missing primitive** (technical pivot):
> "Today, a Solana program cannot own a Bitcoin UTXO. After SODA, it can. One CPI call, real secp256k1 signature, no bridge."

**Frame C — Bridgeless numbers** (urgency close):
> "Bridges lost $3.8B. wBTC is $10B+ of custodial float on one custodian. SODA: the Solana program itself is the owner — no multisig, no custodian, no bridge contract."

### The 60-second version

> **Solana doesn't have Chain Signatures. Near does, and it moved $500M+.**
>
> Every cross-chain Solana product today is a custodian in a trenchcoat. wBTC is custodial. Bridges get hacked — $3.8B gone. Autonomous vaults, AI agents, on-chain treasuries cannot hold a Bitcoin UTXO.
>
> **SODA is the missing primitive.** One CPI call from any Anchor program returns a valid signature on any ECDSA chain. The address is derived from `(program_id, seeds)`, so a Solana PDA is, cryptographically, the owner of the BTC.
>
> Zeus ships one wrapped-BTC product with their private MPC. We're the primitive they never released — any Solana team CPIs in and builds their own zBTC, plus the autonomous products Zeus's custodial flow structurally cannot ship. **Zeus is USDC. SODA is ERC-20.**
>
> Ika's 2PC-MPC requires a user share on every signature — it's a consumer wallet. SODA is PDA-derived, so programs sign without users. **Ika = wallets that touch every chain. SODA = programs that own every chain.**
>
> Colosseum's 5,400-project corpus shows zero direct competitors (similarity ceiling 0.06, noise floor). Anatoly is already angel'd into the thesis via Zeus. Galaxy, Alliance, Multicoin all wrote the essay that SODA is the answer to.
>
> Our demo: a Solana program spends a real Bitcoin testnet UTXO via one CPI call. Live, on-chain, verifiable. That's the whole pitch.

---

## 10.5. Known limitations — and how they compare to the status quo

Every way of making smart contracts hold BTC has a trust surface. The honest question isn't *"is SODA trustless?"* (nothing is) — it's *"is the trust surface smaller than wBTC's?"* Below: real concerns with SODA, side-by-side with the wrapped-BTC / lock-and-mint bridge model it replaces.

### Structural concerns

| Concern | SODA | cbBTC (Coinbase) | wBTC / lock-and-mint bridge |
|---|---|---|---|
| **Who is the trusted party?** | MVP: 3-of-3 dev committee. Prod: restaking-backed committee with slashing (Solayer, Cambrian). | Coinbase Corp. — single corporate custodian, subject to US regulatory seizure. | BitGo (single corporate custodian) or a small federation — e.g., Ronin's 9-of-15 multisig that was compromised for $625M. |
| **Honeypot concentration** | One group pubkey covers every derivation across every caller. | One Coinbase cold-storage infrastructure holds **all** cbBTC's BTC. | *One custodian wallet* holds **all** wBTC's BTC. Strictly worse than SODA — SODA's key is shared across a committee; wBTC/cbBTC's is one legal entity. |
| **Liveness / griefing** | FROST aborts if any signer goes silent. Rotation + slashing needed. | Coinbase can freeze mints/redemptions per court order or compliance policy. | Custodian can halt mints/redemptions unilaterally at any time — already happened (wBTC paused during Justin Sun episode). |

**Net:** SODA splits trust across *k* committee members with cryptographic threshold + economic staking. cbBTC's trust is Coinbase Corp. wBTC's is a Delaware LLC. All three require trust — SODA's is decentralizable and programmable; cbBTC and wBTC are legal entities with subpoena exposure.

### Implementation concerns

| Concern | SODA | wBTC / bridge |
|---|---|---|
| **Upgrade authority = god mode** | Program upgrade key can deploy malicious logic. Mitigation: timelock, DAO, renounce. | Same problem. Bridge upgrade keys **are exactly** how Ronin ($625M) and Poly ($611M) were drained. |
| **Caller-bug amplification** | Caller builds wrong sighash → SODA signs wrong tx. | Bridge mint bug → infinite-mint exploit. BNB ($570M) and Nomad ($190M) were this class. Same bug category, bigger real losses. |
| **Replay protection** | Caller must bake nonce + chain-id + expiry into the signed payload. | Bridge protocol must do the same — Wormhole's $321M loss was a missed signature-check, exact same risk surface. |
| **Key ceremony is one-shot** | DKG is off-chain in MVP; a compromise during ceremony is silent and permanent. | Custodian key generation is also one-shot and off-chain — and historically less scrutinized (no public ceremony). |

**Net:** Every implementation risk SODA carries, bridges already carry — and bridges lost $3.8B+ in production proving it. SODA has not yet shipped, so these remain theoretical; the incumbent has tested them the hard way.

### Operational concerns

| Concern | SODA | wBTC / bridge |
|---|---|---|
| **Finality mismatch** (BTC 10–60 min vs Solana 400 ms) | Programs need confirmation counters before marking "done." | Bridges wait for BTC confirmations too — identical problem, identical mitigation. |
| **Broadcast / relayer trust** | No on-chain proof the sig was broadcast to BTC. | No on-chain proof the deposit was credited by the custodian either. Same risk, offloaded to off-chain monitoring. |
| **DoS economics** | Attacker can spam signing requests cheaply. Rate-limit or per-request fee needed. | Mint requests cost gas, which provides some defense — SODA needs to add its own fee layer. **One genuine SODA-specific gap.** |
| **Regulatory exposure** | Committee signing BTC on behalf of others ≈ money-transmitter exposure in US jurisdictions. | BitGo *is* a licensed MSB. Precedent exists — but also proof that this is a business-ending risk if mishandled. |

### The honest bottom line

> Every drawback SODA has, wBTC and lock-and-mint bridges have too — usually more acutely, with worse UX and a single point of failure. The bridge model has already **lost $3.8B+ proving it.** SODA has one genuinely novel operational gap (DoS fees), and replaces a corporate custodian with a programmable cryptographic committee for everything else.
>
> **"Does this have risks?" is the wrong question. "Are the risks smaller than what it replaces?" is the right one — and the answer is yes, because the incumbent is the one with a $3.8B hack scoreboard.**

| Dimension | SODA risk | wBTC / bridge risk | Winner |
|---|---|---|---|
| Trusted party | Committee (decentralizable) | Single custodian | **SODA** |
| Honeypot size | One pubkey, split | One wallet, whole | **SODA** |
| Upgrade key | Program upgrade | Contract upgrade | **Tie** |
| Caller bugs | Signs bad sighash | Mint bug = infinite mint | **SODA** (signs one bad tx, not infinite) |
| Replay | Caller-level | Protocol-level | **Tie** |
| DoS | Free requests | Gas-costed | **Bridge** |
| Regulatory | MSB exposure | Already MSB | **Tie** |
| Track record | Unshipped | $3.8B lost | **SODA** (by default) |

**Score: SODA 4, Bridge 1, Tie 3.** The drawbacks aren't unique to SODA. They're inherent to any "smart contracts hold BTC" solution. The incumbent just hides them behind a corporate balance sheet and a decade of hacks.

---

## 10.6. Restaking as the committee safeguard

The committee trust surface in §10.5 is closed with **restaking**. SODA runs as an AVS on Solayer / Cambrian:

- Committee operators post **restaked SOL** as bond
- Sign something they shouldn't → stake gets slashed
- Permissionless opt-in — no whitelist; committee grows as SODA TVL grows
- Same pattern Near ChainSig uses on NEAR validators, and EigenLayer uses on Ethereum

**One line:** restaking prices SODA's security by the market, not by a custodian's headcount.

**Important distinction:** the committee is not run by the SODA team. We wrote the program and open-source signer software; **independent restakers opt into our AVS through Solayer.** Same way Wormhole's team doesn't control the Guardian validators. Trust flows through Solayer's staking layer, not through SODA the org — which means SODA the team cannot be a single point of failure.

---

## 10.7. Decentralization vs the BTC options Solana users already have

When someone says "SODA is too centralized," force the question: *compared to what?* Bitcoin self-custody is impossible for smart contracts, so the honest comparison is to the other "smart contracts hold BTC" options on Solana today.

| Solution on Solana | Trust model | # of entities | Failure mode |
|---|---|---|---|
| **wBTC** (via Portal bridge) | BitGo custody + Wormhole validators (stacked trust) | 1 company + ~19 validators | BitGo bad day OR bridge hack (Wormhole lost $321M in 2022) |
| **cbBTC** | Coinbase corporate custody | 1 company (Coinbase) | Coinbase hack / seizure / insolvency |
| **zBTC** (Zeus Network) | Private Guardian MPC (closed federation) | ~5 named Guardian nodes, team-chosen | Threshold collusion among a closed set |
| **SODA MVP** | Dev committee | 3 nodes (hackathon only, labeled) | Acknowledged — MVP trust model |
| **SODA at maturity** | Solayer AVS restakers | 100+ permissionless operators, growing with TVL | Requires threshold collusion among slashable stakers |

### Row-by-row

**wBTC (via Portal).** The same BitGo-custodied BTC that exists on Ethereum, bridged to Solana via Wormhole's Portal. You're now trusting **two layers**: BitGo's corporate custody AND Wormhole's ~19-validator Guardian set. Stacked trust is strictly worse than either layer alone.

**cbBTC.** Coinbase's answer to wBTC. Backed by Coinbase's actual BTC custody. Growing share because Coinbase controls user distribution, but architecturally it's "trust one corporation" — same category as wBTC.

**zBTC (Zeus Network).** The closest direct competitor. Zeus runs a private Guardian MPC to sign BTC transactions on Solana's behalf. Closed federation — Zeus picks the Guardians; they're not permissionless. Also: zBTC is **one product** (wrapped BTC). SODA is the **primitive** any program can call to build their own zBTC equivalents without needing Zeus's permission.

**SODA MVP.** 3 dev-run nodes, hackathon scope. Clearly labeled as "demo trust model, not production." The honest disclosure.

**SODA at maturity.** Solayer AVS with permissionless restaker operators, stake-weighted threshold, slashable bond, proactive share resharing every epoch. 100+ operators is the target, no upper bound — grows with TVL.

### The pitch move when someone says "too centralized"

> "Compared to what? Bitcoin self-custody is impossible for a smart contract — by that standard wBTC shouldn't exist either. Compared to Solana's actual BTC options: wBTC stacks BitGo custody plus Wormhole's Guardians; cbBTC is Coinbase alone; zBTC is Zeus's closed Guardian set. SODA at maturity is 100+ permissionless, slashable restakers. We beat all three. If 100+ still isn't decentralized enough, then no smart-contract BTC solution is — and the $10B sitting in wBTC, cbBTC, and zBTC all have to go with us."

**Short punchy version:**
> "wBTC = BitGo + Wormhole. cbBTC = Coinbase. zBTC = Zeus's closed federation. SODA = 100+ permissionless restakers, slashable. Name a more decentralized way to put BTC inside Solana programs — there isn't one."

**Honest MVP disclosure:**
> "Our MVP is 3 nodes — hackathon scope. Production runs on Solayer's AVS with permissionless restakers. Same transition Near made with ChainSig, same pattern EigenLayer uses on Ethereum. MVP ≠ endpoint."

### The "compared to what?" logic trap in plain steps

The pitch move above is rhetorical judo — it sets a trap the critic cannot escape. Here's the argument broken down step by step so it's deliverable cold:

**Step 1** — Critic says: "SODA is too centralized."

**Step 2** — You reply: "Centralized compared to what?"
- If they answer "compared to Bitcoin self-custody" → that comparison is unfair. No smart contract can hold its own keys. Not wBTC, not zBTC, not Coinbase. *Nothing* on any chain meets that bar.

**Step 3** — The honest comparison is to other "smart contracts hold BTC" options. Rank them:
- wBTC = 1 corporate custodian (+ Wormhole validators when on Solana)
- cbBTC = 1 corporate custodian (Coinbase)
- zBTC = ~5 Guardian nodes in Zeus's closed federation
- SODA at maturity = 100+ permissionless restakers
- **SODA wins the ranking.**

**Step 4** — The trap. The critic now has two exits, both losing:
- **Accept the ranking** → SODA is the most decentralized option in the category. You win.
- **Reject the ranking** ("100+ still isn't enough") → then no smart-contract BTC solution is enough, and **the $10B in wBTC, cbBTC, and zBTC shouldn't exist either**. They have to take the entire incumbent category down with SODA.

Either way, the critic loses. They can't attack SODA's decentralization without also attacking the $10B+ of wrapped BTC already sitting on Solana that they implicitly accept.

**The one-line version of the whole move:**
> "We're the most decentralized option in this category. If that's still not enough, then wBTC shouldn't exist. Pick your poison."

### Also: SODA is a primitive, not a product

zBTC, cbBTC, and wBTC are **products** — specific wrapped-BTC tokens with fixed trust models. SODA is a **primitive** — any Anchor program CPIs into it and gets back BTC/ETH/EVM signatures. That means:

- **A team could build "zBTC clone on SODA"** — same product, open trust model, no Zeus-controlled Guardians
- **A team could build a perps hedger that opens an ETH position from Solana** — no wrapped token involved at all
- **An AI agent could hold native BTC** — no bridge, no wrapping, just CPI calls

SODA competes with wBTC/cbBTC/zBTC on decentralization, but its actual win is being the layer underneath — the thing other Solana protocols build wrapped-BTC-alternatives on top of.

---

## 10.8. Honest security claims — what we claim and what we don't

The fair critique of §10.7: "You can't claim most-secure when you haven't shipped." Correct. We don't claim that. Here's the honest distinction.

| What SODA CAN claim | What SODA CANNOT claim |
|---|---|
| Architecturally most decentralized at maturity | Most battle-tested in production |
| Inherits proven cryptography (FROST-secp256k1, ZF-maintained, underpins Zcash) | Our specific code has a production track record |
| Inherits proven economic pattern (tBTC threshold MPC, EigenLayer AVS model) | Our specific implementation is live |
| MVP scope is honestly disclosed (3-of-3 dev nodes, hackathon label) | Production security guarantees before audit + testnet |

### The defense stack when someone says "you're unshipped, how can you claim security?"

**Move 1 — Concede the gap.**
> "You're right. We're unshipped. Competitors have operational history we don't."

**Move 2 — Reframe to architecture vs implementation.**
> "The architectural pattern we use — threshold MPC + restaked permissionless operators + on-chain slashing — is already live in tBTC on Ethereum/Bitcoin, and across EigenLayer's AVSes securing ~$10B of restaked capital. The security *model* is battle-tested. Our implementation of it is what's new."

**Move 3 — Counter with the incumbent scoreboard.**
> "Competitors that HAVE shipped also shipped a hack scoreboard — Wormhole $321M, Ronin $625M, Poly $611M, BNB $570M, Nomad $190M. $3.8B+ in bridge losses. Being live ≠ being safe. We're not copying what broke; we're copying what's working — tBTC and EigenLayer AVSes."

**Move 4 — Close with a disciplined roadmap.**
> "Before mainnet: formal audit, testnet-only phase, capped TVL at launch, incremental rollout as the committee grows. Not overclaiming — disclosing."

### The one-line answer

> "We're not the most battle-tested — we're unshipped, honest about that. We're the most decentralized *architecture* among Solana BTC options, using cryptography and economic models that ARE battle-tested elsewhere. Competitors that shipped also shipped $3.8B in hacks. Track record isn't their strongest card."

---

## 10.9. Security scales with TVL — the stake-to-TVL constraint and fee flywheel

### The universal PoS constraint SODA inherits

> **Total slashable stake > Total Value Locked (TVL) being protected**

If SODA holds $100M of BTC across all derivations but the committee's total slashable bond is only $10M, a rational attacker attacks: steal $100M, forfeit $10M, net +$90M. Security is economically broken.

**The ratio:** `committee_bond / TVL_protected ≥ safety_multiplier` (typically 1.5x to 3x).

This isn't SODA-specific. Ethereum, Cosmos Hub, and every PoS chain carries the same constraint — stake must exceed secured value. **SODA inherits it from the staking layer; doesn't invent it.**

**What this means for growth:**
- TVL grows → committee bond must grow faster
- If it doesn't, SODA either (a) caps new TVL at launch, (b) raises fees to attract more operators, or (c) routes high-value protocols to dedicated larger committees
- Equilibrium: `committee_bond ≈ safety_multiplier × TVL`

### The fee mechanism — how the committee gets paid

Every `request_signature` CPI call pays a fee with four components:

| Component | What it pays for | Who receives |
|---|---|---|
| **Base signing fee** | Committee work to produce the signature | Participating operators |
| **Priority fee** | Faster turnaround during congestion | Operators who respond first |
| **Protocol fee** | SODA development + treasury | SODA treasury |
| **Chain gas** | Submitting shares + aggregation tx | Solana network |

### Illustrative numbers (5 bps fee, 80/20 split committee/treasury)

| Daily signed volume | Committee fees/day | What it triggers |
|---|---|---|
| **$10M** | ~$4k | Small hobby-scale committee viable |
| **$100M** | ~$40k | Operator APY attractive — more Solayer restakers join |
| **$1B** (bridge-scale) | ~$400k | Committee races to expand; APY compresses to market rate |

### The self-regulating flywheel

```
TVL grows
   ↓
Signing volume grows
   ↓
Committee fees grow
   ↓
Operator APY rises above market
   ↓
More Solayer operators opt in
   ↓
Committee size grows, APY drops back to market rate
   ↓
New equilibrium: bigger committee, same per-operator yield
```

At steady state, committee size tracks fee throughput the way Ethereum's validator set tracked ETH TVL growth from 2020 onward.

### Edge case: TVL grows faster than operator adoption

Three mitigations, used in combination:
1. **Dynamic fee rate** — raise per-signature fee during congestion to attract operators
2. **TVL rate-limiting at launch** — cap max TVL per epoch until committee reaches safety ratio
3. **Tiered committees** — high-value protocols (treasury vaults, institutional flows) opt into dedicated larger committees with higher fees and higher safety margins

### The incentive one-liner

> "Each signing request pays a fee. 80% goes to committee operators proportional to participation. More TVL → more fees → higher APY → more Solayer restakers opt in. The committee self-sizes to market demand, the way Ethereum's validator set self-sized as ETH TVL grew."

---

## 10.10. Zeus vs SODA — the honest security delta

### Right now (MVP): Zeus beats us on security

- Zeus has ~18 months live, no confirmed hacks
- SODA is unshipped
- In empirical "has this survived reality" terms, Zeus wins. We concede this cleanly — no overclaiming.

### At scale (production): SODA beats Zeus on security

Six structural wins, not just permissionlessness:

| Attribute | Zeus / zBTC | SODA at production |
|---|---|---|
| **Committee size at $1B TVL** | Still ~5 Guardians | 100+ operators (committee grows with TVL) |
| **Joining mechanism** | Zeus picks Guardians | Permissionless — anyone posts stake via Solayer |
| **Slashing enforcement** | Reputational / contractual (Zeus's word) | Programmatic, on-chain, automatic |
| **Economic security** | Fixed by Guardian count | Scales linearly with restaked SOL in the AVS |
| **Share rotation** | Unknown / private | Proactive resharing every epoch — old compromises expire |
| **Team SPOF** | Zeus the company IS a single point of failure | SODA team is just program authors; committee is independent |
| **Audit surface** | Closed, private ops | Open-source signer, public DKG logs, on-chain slashing events |

### Why each dimension matters

**1. Economic security scales with TVL.** At $100M TVL, Zeus and SODA are roughly equivalent. At $10B TVL, Zeus is still 5 Guardians guarding $10B (each individually worth attacking); SODA has 100+ operators with aggregate stake exceeding the protected value.

**2. Slashing is code, not a handshake.** Zeus Guardians presumably have legal contracts with Zeus. If a Guardian misbehaves, Zeus has to sue / fire / publicize. SODA operators get slashed automatically on-chain — no court, no delay, no reputational negotiation.

**3. Proactive resharing shrinks attack windows.** If someone compromises a Zeus Guardian's key, they hold a valid share until Zeus rotates (when? how? who knows). SODA shares refresh every epoch — a stolen share expires within hours.

**4. No team SPOF.** If Zeus the company has regulatory issues, leadership collapse, or a hostile acquisition, zBTC breaks. SODA's committee runs on Solayer regardless of what happens to the SODA team. Removing the team as a SPOF is a direct result of permissionlessness, but it's a separate concrete security win.

**5. Transparency.** Zeus's operational procedures are private. SODA's signer is open-source, DKG ceremonies are logged on-chain, slashing events are public. More eyes = faster bug discovery.

**6. Permissionlessness itself** — anyone can join, so the committee can grow arbitrarily large. No gatekeeping.

### The clean pitch answer

> "Right now, Zeus is more battle-tested — 18 months live beats unshipped. But at scale, SODA is structurally more secure on six dimensions: committee grows with TVL, slashing is code-enforced not reputational, shares rotate every epoch, no company SPOF, open-source and on-chain auditable, and permissionless opt-in. Zeus is ahead today because they shipped first. SODA's architecture pulls ahead once we ship and hit meaningful TVL."

### The blunt one-liner

> "Zeus's security is fixed at 5 people Zeus chose. Mine grows to 100+ people who posted stake. At $100M TVL we're equivalent. At $1B TVL, we're the ones still sleeping at night."

### What this means for the pitch

Don't claim "more secure than Zeus" flatly — it's overclaiming. Instead:

- **Short-term (today):** "Zeus is ahead on operational track record; we're ahead on architecture."
- **Long-term (production + scale):** "Our security scales; theirs is capped at a fixed Guardian set."
- **Honest disclosure:** "At MVP we're 3 nodes; at production we're 100+ permissionless restakers. The architecture wins as TVL grows."

---

## 11. Repo layout

```
frontier/
├── programs/
│   ├── soda/                  # Anchor program — the MPC primitive
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── state.rs          # Committee, SigRequest, events
│   │       ├── derivation.rs     # foreign_pubkey = group + H(...) * G
│   │       ├── crypto/verify.rs  # secp256k1_recover syscall wrapper
│   │       └── instructions/     # init_committee, request_signature, finalize_signature, cancel_expired
│   └── btc-vault-demo/          # Demo program that CPIs into SODA
│       └── src/lib.rs            # init_vault, request_withdraw
├── apps/
│   ├── signer/                  # Rust Tokio daemon — single-key MVP signer
│   │   └── src/
│   │       ├── main.rs
│   │       ├── frost_state.rs   # keyshare load + ECDSA signing
│   │       ├── derivation.rs    # tweaked secret derivation
│   │       ├── sig_request.rs   # event log decoder
│   │       └── rpc.rs           # JSON-RPC HTTP + WebSocket subscribe
│   └── web/                     # Next.js 16 App Router frontend
│       ├── app/
│       │   ├── page.tsx          # landing
│       │   └── demo/
│       │       ├── layout.tsx
│       │       ├── deposit/page.tsx
│       │       └── withdraw/{page.tsx,WithdrawFlow.tsx}
│       └── components/           # ForeignAddressCard, SigRequestTimeline
├── packages/
│   └── soda-sdk/              # TypeScript client — derive, request, bitcoin
│       └── src/{index.ts, derive.ts, request.ts, bitcoin.ts}
├── tests/
│   ├── integration/             # Anchor mocha: soda.ts, btc-demo.ts
│   ├── e2e/                     # Playwright: demo.spec.ts
│   └── tsconfig.json
├── Anchor.toml
├── Cargo.toml                   # Rust workspace
├── package.json                 # npm workspace
└── tsconfig.json                # project references
```

## 12. Prerequisites

Install these once. Pinning versions matters because Anchor `0.30.1` is tied to a specific Solana release.

| Tool | Version | Why |
|------|---------|-----|
| Node | ≥ 20 | Next.js 16, SDK, tests |
| npm | ≥ 10 | Workspaces |
| Rust | stable | Anchor programs + signer daemon |
| Solana CLI | `1.18.22` | `cargo-build-sbf`, `solana-test-validator`, `solana program deploy` |
| Anchor CLI | `0.30.1` | `anchor build`, `anchor test`, `anchor deploy` |
| Bitcoin Core (optional) | ≥ 26 | Regtest loop for local demo |

### Install Solana CLI (Windows / WSL)

This repo assumes Solana CLI is on your PATH. Windows-native Solana is unofficial — run from WSL:

```bash
sh -c "$(curl -sSfL https://release.solana.com/v1.18.22/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version    # solana-cli 1.18.22 (...)
```

Then set up a local keypair and devnet RPC:

```bash
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json
solana config set --url https://api.devnet.solana.com
solana airdrop 2
```

### Install Anchor

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1
avm use 0.30.1
anchor --version    # anchor-cli 0.30.1
```

## 13. Build and test

```bash
npm install                      # npm workspace install
anchor build                     # compiles programs/soda + programs/btc-vault-demo
anchor test                      # spins up solana-test-validator, runs tests/integration/**.ts
npm run build                    # builds frontend + SDK
```

### Run the signer daemon (localnet)

```bash
# 1. Generate a dev keyshare
echo '{"secret_hex":"c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721","comment":"DEV ONLY"}' > keyshare.dev.json

# 2. Start the daemon — it subscribes to program logs via WS and signs requests
cargo run -p soda-signer -- \
  --keyshare ./keyshare.dev.json \
  --solana-key ~/.config/solana/id.json \
  --program-id SodaProgramPubkeyPlaceholder11111111111111111 \
  --rpc http://127.0.0.1:8899 \
  --ws ws://127.0.0.1:8900
```

### Run the frontend

```bash
npm run dev                      # http://localhost:3000
```

The demo flow is `/` → `/demo/deposit` → `/demo/withdraw`. All derivation is client-side; the signature timeline is mocked with staged timeouts until RPC wiring lands.

## 14. Deploy to devnet

```bash
# 1. Replace placeholder program IDs with real ones
solana-keygen new -o target/deploy/soda-keypair.json --no-bip39-passphrase
solana-keygen new -o target/deploy/btc_vault_demo-keypair.json --no-bip39-passphrase
solana-keygen pubkey target/deploy/soda-keypair.json
# Paste the output into programs/soda/src/lib.rs `declare_id!(...)` and Anchor.toml.
# Same for btc_vault_demo.

# 2. Build + deploy
anchor build
anchor deploy --provider.cluster devnet

# 3. Bootstrap the committee
# (Use the init_committee instruction via a one-off script with your group pubkey.)
```

## 15. MVP scope vs full design

Shipping now:

- [x] Deterministic foreign-pubkey derivation (on-chain + SDK, matching bits-for-bits)
- [x] `request_signature` CPI entry, with `SigRequested` event
- [x] `finalize_signature` with on-chain ECDSA verification via `secp256k1_recover`
- [x] `cancel_expired` for rent reclamation
- [x] Demo vault program with a working CPI
- [x] TypeScript SDK: derive, BIP143 sighash, bech32 P2WPKH encode, instruction encoders
- [x] Rust signer daemon (MVP: single-key trusted signer, FROST-shaped interface)
- [x] Next.js 16 App Router UI with live derivation and timeline

Deferred to post-hackathon:

- [ ] Real FROST-secp256k1 aggregation (per-share `SignerShare` PDAs + threshold aggregation)
- [ ] On-chain DKG with slashing via Solayer/Cambrian restaking
- [ ] Ed25519 threshold signing (Cosmos / another Solana)
- [ ] Indexer + push notifications
- [ ] Multi-input Bitcoin tx construction (MVP is single-input P2WPKH)

## 16. License

MIT.
