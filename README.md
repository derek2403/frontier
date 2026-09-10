# SODA — Solana-Owned Derived Authority

**A Solana wallet that owns addresses on other chains.**

Connect Phantom, sign one Solana transaction, and an Ethereum address that
belongs to your Solana wallet deposits into Aave, borrows USDC, or does
anything else an Ethereum account can do. No bridge, no wrapped tokens, no
second wallet, no ETH to hold. The user only ever touches SOL.

- Live demo: <https://frontier-web-five.vercel.app> (Solana devnet → Base Sepolia)
- Docs: <https://frontier-docs-cazz.vercel.app>
- Programs on devnet: `soda` `CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J`, `eth_demo` `9JMr3TNHk2Mh7TQsaoxkfDmLFE3naYcAwcsgkKv3BBXx`

---

## The problem

Solana has the users, the speed and the fees. The liquidity and the
protocols people want to use are spread across Ethereum, Base and a dozen
other chains. Today, reaching them from Solana means one of:

- **A bridge.** You lock assets on one side and trust a third party to mint
  on the other. Bridges are the single largest source of stolen funds in
  crypto: Ronin, Wormhole, Nomad and Multichain alone lost well over a
  billion dollars.
- **A second wallet.** Install MetaMask, buy ETH for gas, manage a second
  seed phrase, and hope the two wallets never get confused. Most Solana users
  never make it past this step.
- **A custodian.** Hand the keys to someone else. For an institution this
  means a separate custody arrangement, a separate signing policy and a
  separate audit trail per chain.

For institutions the pain is sharper. A fund or treasury on Solana that
wants yield on Ethereum needs multi-chain custody, per-chain key ceremonies,
per-chain approval flows, and reconciliation between systems that were never
designed to talk to each other. Every extra chain is a new operational
surface and a new way to lose money.

## What SODA does

SODA gives every Solana account a deterministic address on every other
ECDSA chain (Ethereum, Base, Arbitrum, Polygon, BNB, Avalanche, and with a
different encoder, Bitcoin). Nobody holds the private key for that address.
It can only sign when the SODA program on Solana says so, and the program
only says so when the owning Solana account has signed a request.

From the user's side:

1. Connect a Solana wallet.
2. See the Ethereum address it owns.
3. Click an action. Phantom asks for one Solana signature.
4. The Ethereum transaction lands, sent from that address.

From the protocol's side, the Ethereum transaction was authorised by a
Solana signature, proven on Solana, and only then signed and broadcast.
Every action leaves a Solana transaction behind it, so the audit trail is
on-chain and complete.

The owner does not have to be a person. The same derivation works for a
program-derived address (PDA), so a Solana **program** can own an Ethereum
or Bitcoin address and act on it by CPI, with no human and no custodian in
the loop. Phantom is a wallet for people; SODA is also a wallet for smart
contracts. A contract cannot click "Sign", and until now that meant every
autonomous vault, agent or scheduled strategy on Solana had to hand its
foreign-chain keys to a SaaS custodian.

## What works today

Everything below has been run end to end on Solana devnet and Base Sepolia
and is reproducible with the commands further down.

| Step | Where | What |
|---|---|---|
| Request | Solana, `eth_demo` → `soda` | Phantom signs `sign_eth_transfer`. The program builds the exact EVM transaction, hashes it, derives the foreign address from the signer, and records a `SigRequest`. |
| Sign | Committee | The committee signs the hash with the key for that address. |
| Verify | Solana, `soda::finalize_signature` | The program runs `secp256k1_recover` on the signature and refuses unless it recovers to the address it derived. |
| Broadcast | Base Sepolia | The signed transaction is sent. |
| Act | Aave V3 | `depositETH` puts ETH into Aave; the Solana wallet's address receives aWETH and earns interest. `Pool.borrow` takes USDC out against that collateral. |
| Audit | `pnpm verify <hash>` | Anyone can tie the broadcast transaction back to the Solana request in eight checks, using only public state. |

A concrete run: the Solana wallet `D5pwjGzq…` owns
`0xd55282657a707792c1be66a511f81d7d45ff1ce5` on Base Sepolia. That address
has deposited ETH into Aave three times and borrowed 0.1 USDC against it
([borrow tx](https://sepolia.basescan.org/tx/0x732af17f38094e7513cd7680ab79c2802b8733fa58be48e9ec701f24bc4b8db9)).
Aave's own Pool contract reports the position: about $0.75 of collateral,
$0.10 of debt, health factor 6.4. No private key for that address exists.

Two chains are wired up, Ethereum Sepolia and Base Sepolia. Adding a chain is
one entry in `packages/soda-sdk/src/chains.ts`.

## How it works

### 1. Every Solana account has a foreign address

The committee holds one secp256k1 key pair, `group_sk` / `group_pk`. Each
Solana account gets its own address by *tweaking* that key:

```
tweak      = sha256("SODA-v1" ‖ owner_pubkey ‖ path ‖ chain_tag)
foreign_pk = group_pk + tweak · G
address    = keccak256(foreign_pk)[12..]        (for EVM chains)
```

`owner_pubkey` is the Solana account. `path` lets one owner have many
addresses. `chain_tag` gives the same owner a different address per chain.
The tweak is public; the secret that signs for the address is
`group_sk + tweak`, which only the committee can form.

This is the same construction NEAR chain signatures use. It is
deterministic (the address never changes and needs no registry) and it is
non-custodial in the sense that matters: the committee cannot pick which
address to sign for. It signs for whichever address the Solana program
derived from whoever signed the request.

### 2. The program derives the address itself

The caller never tells the program which address to use. `request_signature`
computes the tweak from the transaction's signer and derives `foreign_pk` on
chain, so a malicious client cannot request a signature for someone else's
address.

Doing elliptic-curve arithmetic inside a Solana program used to be
impossible: the BPF stack is 4 KB and a full point addition blew it. SODA
sidesteps the arithmetic with a trick. Solana has a `secp256k1_recover`
syscall for verifying Ethereum signatures. Feed it a carefully chosen
"signature" and it returns `P + t·G` for any point `P` and scalar `t`,
which is exactly the derivation. One syscall, no point math, about 25k
compute units. The trick is cross-checked against a real curve library in
the program's tests.

### 3. The committee signs, and only what was requested

The committee watches Solana for `SigRequested` events. For each one it
reads the request account, re-derives the address from the on-chain
requester, and signs the 32-byte payload the program stored. It never
accepts a payload or an address from anyone off-chain. The request also
carries an expiry and a domain, and completed requests are refused.

Today the committee is a 2-of-2 threshold-ECDSA pair (Lindell '17) running
on two hosts. Neither host ever holds the whole key.

### 4. Solana verifies the signature before anything is broadcast

`finalize_signature` takes the committee's signature and runs
`secp256k1_recover` on the stored payload. If the recovered public key is
not the `foreign_pk` the program derived in step 2, the transaction fails.
Only a signature that provably came from the right key, over the right
payload, gets recorded. The relayer broadcasts from what Solana recorded,
not from what the committee sent it.

### 5. Gas on the other chain

Ethereum gas is paid by the sending address, so the derived address needs a
little ETH. In the demo a sponsor key tops it up just in time, capped at
0.002 ETH per run. In production this is a relayer that fronts the gas and
bills the user in SOL at request time, so the user still never holds ETH.
The relayer is paid for a service, not trusted with a key: it can delay a
transaction, it cannot alter one.

### What the user signs, and what they do not

The user signs exactly one thing: the Solana `sign_eth_transfer`
transaction, which contains the complete EVM transaction (recipient, value,
calldata, nonce, gas, chain). What Phantom shows is what will happen. The
user never sees a raw Ethereum signing prompt, never holds ETH, and never
learns a second seed phrase.

## Security model, honestly

What is proven today:

- The address is derived on chain from the signer. No client-supplied
  addresses.
- The signature is verified on chain before broadcast. A wrong or forged
  signature is rejected by the Solana runtime.
- The committee nodes re-derive and authorise from on-chain state only.
- Every action is a Solana transaction, so the audit log is public and
  complete.

What is not yet where it needs to be:

- **The committee is 2-of-2 under one operator.** Both shares are run by
  us. That is a demo, not decentralisation. Zero fault tolerance: lose one
  host and every derived address is frozen.
- **The 2-of-2 protocol cannot apply the per-address tweak yet.** Lindell
  '17 as shipped shares the key multiplicatively, so the derivation has to
  be applied through the Paillier ciphertext on the second node. The fix is
  identified and small; until it lands, the live demo signs with a single
  key held by the server, which does apply the tweak correctly. The on-chain
  verification is identical in both modes.
- **Shares are plaintext files.** Production wants TEE or KMS-wrapped
  shares.
- **Requests are free.** Nothing stops someone spamming `request_signature`.
  The per-request fee above is the fix, and it is also the business model.
- **The program has an upgrade authority.** As with every bridge that was
  ever drained through its upgrade key, this needs a timelock and a
  multisig before real value sits behind it.

The trust today is "the operator will not misuse the key". The trust at the
end of the roadmap is "at least *t* of *n* independent, bonded operators
would have to collude, and the program on Solana still verifies every
signature regardless". Every risk in this list also exists for wrapped
assets and bridges, usually in a worse form with a single corporate key.
The right question is not "is it trustless" but "is the trust surface
smaller than what it replaces".

## Use cases

**For users, today:**

- **Use any DeFi protocol with only a Solana wallet and SOL.** Lend on Aave,
  trade on Uniswap, provide liquidity, claim airdrops, mint NFTs, on any
  EVM chain, with one Phantom approval each. The demo does the first two.
- **Wallets and apps with a single seed.** A Solana wallet can present a
  Bitcoin or Ethereum balance and let the user act on it, without adding a
  chain to the wallet.

**For programs, which is where it gets interesting:**

- **A vault that hedges on another venue at 3am.** A Solana vault holds SOL
  and needs a short ETH perp on an Ethereum-side venue when the price moves.
  Today either a human wakes up or a custodian's key signs. With SODA the
  vault program requests the signature by CPI. The PDA *is* the account on
  the other venue.
- **AI agents with their own cross-chain identity.** An agent that lives as
  a Solana program gets a Bitcoin and an Ethereum address from the same
  seeds. It can settle, rebalance and pay invoices on those chains without
  a Turnkey or Privy key behind it.
- **A non-custodial wrapped-BTC, by anyone.** Deposit BTC to an address a
  Solana PDA owns, mint a receipt token, burn to redeem and the program
  signs the BTC spend back. No BitGo, no Coinbase, no closed federation.
  Zeus ships one of these; SODA lets anyone ship one.
- **Composition in one Solana transaction.** Swap on Jupiter, hedge on an
  Ethereum venue, pay a Bitcoin invoice, in one slot, reverting as a unit
  if any leg fails. Bridges cannot compose like this because they need
  finality on both sides between steps.
- **Cross-chain treasury from one signing policy.** A Solana multisig or DAO
  owns addresses on every chain. One approval flow, one audit trail, no
  per-chain custody.
- **Intents and escrow.** A program holds a foreign asset and releases it
  only when an on-chain condition is met.

## For institutions

- **One key management story.** The Solana signing policy the desk already
  has (hardware wallets, multisig, approval thresholds) governs every chain.
  There is no second HSM, no second ceremony, no second policy to keep in
  sync.
- **A complete, public audit trail.** Every foreign-chain action begins as
  a Solana transaction that records the full payload. Compliance can
  reconstruct exactly who authorised what, and when, from public data.
- **No bridge risk on the balance sheet.** Assets are never locked in a
  bridge contract. The derived address holds them directly on the
  destination chain.
- **Deterministic addresses.** Counterparties can be given the address
  before any transaction exists; it can be whitelisted, monitored and
  proven to belong to a specific Solana account.
- **Operator model that fits regulation.** Committee operators can be
  required to run in attested TEEs, be bonded via restaking, and be
  geographically and legally diverse. Threshold and operator set are
  on-chain parameters, not promises.

## Why now, and how big

- **Solana is being pitched as the venue for every asset**, and that thesis
  needs a way for Solana to act on other chains that is not a bridge.
- **The custodial model is losing money in production.** cbBTC is a
  ~$6.3B market held by one corporation. zBTC, the closed-federation
  alternative, is ~$14M after 18 months. In April 2026 Drift lost
  $4.4M of wBTC and $590K of zBTC in one incident.
- **The demand is proven elsewhere.** NEAR chain signatures signed over
  $500M of transaction volume in 2025. Cubist secures Lombard's $2B of
  BTC with centralised programmatic signing. SODA is the on-chain,
  permissionless version of that category.
- **Agents need it.** Every AI-agent framework on Solana today assumes a
  SaaS custodian for non-Solana chains.

The market SODA displaces is the bridge and wrapped-asset market, roughly
$15B of TVL. The business model is Wormhole's, with a larger surface:
signatures are a superset of messages.

## Compared with the alternatives

| | What it is | Why it is not SODA |
|---|---|---|
| **Wormhole, LayerZero, deBridge** | Message bridges | They pass notes between chains. SODA passes authority. The other chain never learns Solana exists. |
| **cbBTC, wBTC** | Wrapped assets | One corporation holds the real BTC. SODA holds nothing centrally; each address is owned by a Solana account. |
| **Zeus (zBTC)** | One wrapped-BTC product on a private MPC | Zeus is a product. SODA is the primitive underneath it, open to anyone. Zeus is USDC; SODA is ERC-20. |
| **Ika** | 2PC-MPC wallets, the user holds one share | A user share on every signature means wallets only. A Solana PDA cannot hold a user share. Ika is wallets that touch every chain; SODA is programs that own every chain. |
| **Turnkey, Privy, Cubist** | Hosted signing SaaS | Centralised and closed. Proves the category; SODA is the on-chain, permissionless version. |
| **NEAR chain signatures** | The same primitive, on NEAR | See below. |

## Compared with NEAR chain signatures

NEAR shipped this primitive first, and SODA follows the same design: a
threshold-ECDSA committee, per-account derivation by tweak, the contract
deriving from the caller rather than trusting the caller, and nodes that
re-derive from on-chain state. The differences:

| | NEAR chain signatures | SODA |
|---|---|---|
| Host chain | NEAR | Solana |
| Address derived on chain from the caller | Yes | Yes, via the `secp256k1_recover` trick |
| Signature verified on chain before it is accepted | Yes, in the MPC contract's `respond` | Yes, `secp256k1_recover` in `finalize_signature` |
| Committee today | 9-of-15 on mainnet, 15 named operators voted in on-chain | 2-of-2 (Lindell '17), one operator |
| Operator hardware | Intel TDX bare metal via dstack, attested to the contract; required on testnet, not yet on mainnet | Plain hosts |
| Derivation inside the protocol | Additive shares; the tweak is folded into the presignature | Not yet (see security model) |
| Status | Mainnet since 2024, four Trail of Bits audits | Devnet + testnets |

The primitive is the same. What SODA adds is that it lives on Solana: a
Solana program can request a foreign-chain signature by CPI, the request and
the verification are ordinary Solana transactions, and a Solana wallet is
the only key the user ever holds. What SODA still lacks is NEAR's operator
set and maturity, which is what the roadmap below is about.

## Business model

SODA is infrastructure, paid per use in SOL. Every `request_signature`
carries a fee with three parts:

| Component | Pays for | Goes to |
|---|---|---|
| Base signing fee | The committee's work to produce the signature | Participating operators |
| Priority fee | Faster turnaround under load | Operators who respond first |
| Protocol fee | Development and treasury | SODA treasury |

Destination-chain gas is fronted by the relayer and charged back in SOL
with a margin, so the user never holds another token.

Illustrative numbers at a 5 bps fee with an 80/20 operator/treasury split:

| Daily signed volume | Committee fees per day | Effect |
|---|---|---|
| $10M | ~$4k | A small committee is viable |
| $100M | ~$40k | Operator yield beats market; more restakers join |
| $1B | ~$400k | Committee expands until yield returns to market rate |

This is the flywheel that makes security scale with value. A threshold
committee is only as safe as the stake behind it: slashable bond has to
exceed the value it protects, the same constraint every proof-of-stake
system carries. As signing volume grows, fees grow, operator yield rises,
more restaked operators opt in, and the committee grows with the TVL it
secures. If TVL outruns operator adoption, the levers are a dynamic fee, a
TVL cap per epoch at launch, and dedicated larger committees for
high-value flows.

On top of the protocol fee: an **institutional plan** (dedicated committee,
chosen operator set, TEE attestation, SLAs, SDK integration with the
institution's existing signing policy) and **revenue share** with wallets
and dApps that embed the SDK.

## Roadmap, next three months

1. **Tweak inside the MPC.** Apply the derivation through the Paillier
   ciphertext so the 2-of-2 committee signs for derived addresses. Retire
   the single-key path.
2. **2-of-3 and beyond.** Move to CGG21-family threshold ECDSA, which
   generalises to *t*-of-*n*. Committee threshold and operator set become
   on-chain parameters of the `Committee` account, with `update_committee`
   already in place for rotation.
3. **Independent operators in TEEs.** Three operators in three
   jurisdictions, shares in attested enclaves, restaking bond and slashing
   via on-chain proofs.
4. **More chains, same program.** The Solana program is already
   chain-agnostic. Add Arbitrum, Polygon and BNB as registry entries;
   Bitcoin via a BIP143 encoder in the SDK.
5. **Mainnet-beta pilot** with one institutional partner running a treasury
   address on Base.
6. **Intents.** A Solana program that holds a derived address and releases
   a foreign transaction only when an on-chain condition is met.

## Run it yourself

Prerequisites: Node 24, pnpm, Rust, Solana CLI 3.x, Anchor 0.32. A Solana
wallet at `~/.config/solana/id.json` with a little devnet SOL.

```bash
pnpm install
cp .env.example .env            # set DEMO_CHAIN, RPC URLs, SEPOLIA_FUNDER_KEY
```

**CLI, the canonical demo.** One command does everything and ends with a
cryptographic audit of the transaction it just broadcast:

```bash
./demo.sh                          # Aave depositETH, 0.0001 ETH
DEMO_ACTION=borrow ./demo.sh       # Aave Pool.borrow, 0.1 USDC against the aWETH
DEMO_CHAIN=base-sepolia ./demo.sh  # sepolia | base-sepolia
```

**Web.** The same pipeline with Phantom signing the Solana side:

```bash
cp apps/web/.env.example apps/web/.env
pnpm --filter web dev              # http://localhost:3000
```

**Verify any past transaction** from public state only:

```bash
pnpm verify 0x732af17f38094e7513cd7680ab79c2802b8733fa58be48e9ec701f24bc4b8db9
```

**Tests:**

```bash
cd contracts && cargo test --workspace --lib   # program unit tests, incl. the recover-trick cross-check
pnpm sdk:test                                  # TS derivation, RLP and Aave calldata vectors
```

## Repository layout

```
contracts/programs/soda/       the primitive: init/update committee, request_signature
                               (derives on chain), finalize_signature (secp256k1_recover)
contracts/programs/eth_demo/   example caller: builds the EVM tx, hashes it, CPIs soda
packages/soda-sdk/             TypeScript: derivation, RLP, chain registry, Aave calldata
apps/demo/                     CLI demo (demo.ts) and the audit tool (verify.ts)
apps/web/                      Next.js demo: Phantom → /api/finalize → broadcast
apps/mpc-node/                 threshold-ECDSA node (Lindell '17), on-chain authorisation
apps/mpc-coordinator/          drives the signing protocol between the two nodes
apps/mpc-subscriber/           watches SigRequested, asks the committee, finalizes
apps/relayer/                  event subscriber that assembles and broadcasts signed txs
apps/docs/                     the documentation site
```

## Status

Hackathon build. Live on Solana devnet with Ethereum Sepolia and Base
Sepolia. Not audited. Do not put real money behind a derived address until
the committee is *t*-of-*n* under independent operators.
