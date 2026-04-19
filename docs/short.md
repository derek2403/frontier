# SolSig — Chain Signatures for Solana

> **A Solana program just spent a Bitcoin UTXO.**  
> No wrapped token. No bridge vault. No human signer.

SolSig gives Solana programs a native signing primitive for Bitcoin, Ethereum, and other secp256k1 chains.

With one CPI call, a Solana program can request a valid external-chain signature and control native assets beyond Solana.

## Why this matters

Today, Solana programs cannot natively own or sign for assets on Bitcoin or Ethereum.

That leaves teams with three bad options:

- wrapped assets like wBTC or cbBTC,
- bridges and message-passing systems,
- or humans / custody providers signing off-chain.

SolSig is the missing primitive: **cross-chain signing for smart contracts**.

## What SolSig does

SolSig is an Anchor program plus an off-chain signing committee that exposes signing as a CPI primitive.

```rust
solsig::request_signature(path, payload_hash, target_chain)
```

A Solana program calls this and receives back a valid secp256k1 signature usable on Bitcoin, Ethereum, or another ECDSA chain.

The external address is deterministically derived from the caller’s `program_id` and seeds, so a Solana PDA gets its own native BTC or ETH identity.

## Why it’s different

SolSig is **not**:

- a wrapped-token product,
- a lock-and-mint bridge,
- or a custody workflow.

We are not locking BTC in a shared vault and minting an IOU elsewhere.

We are giving Solana programs the ability to request a real signature that the foreign chain already knows how to verify.

From Bitcoin’s point of view, a normal Bitcoin key signed a normal Bitcoin transaction.

## Demo

**A Solana program spends a real Bitcoin testnet UTXO through one CPI call.**

That is the entire “aha”:

- not a bridge message,
- not a wrapped token,
- not a human signer.

The program actually controls Bitcoin.

## What this unlocks

- **Native-BTC vaults** controlled by Solana program logic
- **Autonomous hedging** on external venues
- **Cross-chain agents** using BTC, ETH, and SOL under one policy engine
- **New BTC-backed products** without a centralized custodian

## Honest limitation

The MVP is not trustless.

It currently uses an off-chain signer committee, and the long-term roadmap is to harden this with threshold signing and stronger economic security.

This hackathon project is about proving the primitive, the developer experience, and the application-layer value.

## TL;DR

**SolSig lets any Solana program request a valid Bitcoin or Ethereum signature with one CPI call.**  
That means smart contracts can control native external-chain assets without wrapped tokens, bridge vaults, or human signers.

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