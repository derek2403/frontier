# SolSig — Chain Signatures for Solana

> **A Solana program just spent a Bitcoin UTXO.**  
> No wrapped token. No bridge vault. No human signing flow.

## One-line summary

SolSig gives Solana programs a native signing primitive for Bitcoin, Ethereum, and other secp256k1 chains, so smart contracts can control real external-chain assets without wrapped tokens, bridge vaults, or human signers.

## The problem

Solana programs are powerful, but they stop at the Solana edge.

A vault, DAO, agent, or protocol can execute logic on Solana, but it cannot natively control assets on Bitcoin, Ethereum, or other secp256k1 chains.

Today, teams only have three options:

- use wrapped assets like wBTC or cbBTC,
- rely on a bridge or message-passing system,
- or depend on a human or custody provider to sign off-chain.

All three add trust, friction, and operational risk.

**That is the missing primitive:** a Solana program cannot directly own and sign for assets on another chain.

## The solution

SolSig is an Anchor program plus an off-chain signing committee that exposes **cross-chain signing as a CPI primitive**.

A Solana program calls:

```rust
solsig::request_signature(path, payload_hash, target_chain)
```

and receives back a valid secp256k1 signature usable on Bitcoin, Ethereum, or another ECDSA chain.

The foreign-chain address is deterministically derived from the caller’s `program_id` and seeds, so the same Solana PDA maps to the same external-chain address every time.

In practice, that means a Solana program gets its own native BTC or ETH identity.

## Why this is different

SolSig is **not** a lock-and-mint bridge and **not** a wrapped-token product.

We are not locking BTC in a shared vault and minting an IOU somewhere else.  
We are not asking Bitcoin or Ethereum to verify that “Solana said so.”  
We are giving a Solana program the ability to request a real signature that the foreign chain already knows how to verify.

From Bitcoin’s point of view, a normal Bitcoin key signed a normal Bitcoin transaction. Bitcoin does not need to know Solana exists.

## What this unlocks

This primitive enables a new class of Solana applications:

- **Native-BTC vaults** controlled by program logic
- **Autonomous hedging** on external venues without a human signer
- **Cross-chain agents** that can act with BTC, ETH, and SOL under one on-chain policy engine
- **New BTC-backed products** built without a centralized custodian

The key idea is simple:

**Programs can finally control native assets beyond Solana.**

## Why now

The timing is strong for three reasons:

1. Solana is becoming a serious execution layer for trading, agents, and consumer apps.
2. Demand for Bitcoin-on-Solana products already exists, but current solutions are mostly custodial or federation-based.
3. Teams increasingly want policy-based, programmable cross-chain control rather than more wrapped assets and bridge dependencies.

SolSig fits that shift by turning external-chain signing into infrastructure any Anchor program can call.

## Demo

Our demo is the shortest possible proof that the primitive matters:

**A Solana program spends a real Bitcoin testnet UTXO through one CPI call.**

That is the “aha” moment.

This is not a bridge message.  
This is not a wrapped token.  
This is not a custody workflow.

The program actually controls Bitcoin.

## Why this project matters

SolSig is not just another Bitcoin product on Solana.

It is the **primitive underneath** a whole category of products.

Instead of launching one more wrapped BTC asset, SolSig exposes signing itself as infrastructure:

- protocols can integrate it with one CPI call,
- developers can build new BTC and cross-chain apps on top,
- and Solana programs can move from “local execution only” to real multi-chain control.

That makes SolSig an infrastructure play with a clear demo, a visible market, and a strong developer wedge.

## Honest limitation

The MVP is not trustless, and we do not present it that way.

Today’s version uses an off-chain signer committee. The long-term roadmap is to harden that model with threshold signing and stronger economic security.

The point of this hackathon project is to prove the primitive, the developer experience, and the application-layer value.

The claim is not “we solved cross-chain trust forever.”

The claim is:

**We proved that Solana programs can natively control external-chain assets through a clean signing primitive.**

## TL;DR

**SolSig lets any Solana program request a valid Bitcoin or Ethereum signature with one CPI call.**  
That means smart contracts can control native external-chain assets for the first time, without a wrapped token, a bridge vault, or a human clicking sign.

## Repo layout

```text
frontier/
├── programs/
│   ├── solsig/
│   └── btc-vault-demo/
├── apps/
│   ├── signer/
│   └── web/
├── packages/
│   └── solsig-sdk/
├── tests/
├── Anchor.toml
├── Cargo.toml
├── package.json
└── tsconfig.json
```

## MVP scope

### Shipping now

- Deterministic foreign-pubkey derivation
- `request_signature` CPI entry
- Signature completion flow
- Demo vault program
- TypeScript SDK
- Rust signer daemon
- Frontend demo

### Deferred

- Real FROST-secp256k1 aggregation
- On-chain DKG
- Restaking-backed slashing
- Ed25519 threshold signing
- Indexer and notifications
- Multi-input Bitcoin transactions

## License

MIT.