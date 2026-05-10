# Why SolSig

## The core idea

SolSig exists because Solana programs can execute logic on Solana, but they cannot natively control assets on Bitcoin, Ethereum, or other secp256k1 chains.

That missing primitive matters more than it looks. It is the reason cross-chain applications still rely on one of three compromises:

- wrapped assets,
- bridges and message-passing systems,
- or humans / custody providers signing off-chain.

All three work around the same limitation: a Solana program cannot directly request a valid foreign-chain signature under its own program logic.

SolSig fixes that.

## What SolSig is

SolSig is an Anchor program plus an off-chain signing committee that exposes cross-chain signing as a CPI primitive.

A Solana program requests a signature and receives back a valid secp256k1 signature usable on Bitcoin, Ethereum, or another ECDSA chain. The foreign-chain address is deterministically derived from the caller’s `program_id` and seeds, so a Solana PDA gets its own stable external-chain identity.

In plain English:

**SolSig gives smart contracts a wallet-like primitive for external chains.**

That is the product.

## What SolSig is not

SolSig is not a wrapped-token product.

SolSig is not a lock-and-mint bridge.

SolSig is not a UI wallet for humans.

We are not taking BTC into a shared vault and minting an IOU somewhere else.  
We are not asking Bitcoin to verify a cross-chain message from Solana.  
We are not asking a person to wake up and click “sign” at the critical moment.

Instead, we let Solana programs request real signatures that foreign chains already know how to verify.

That distinction is the whole thesis.

## Why this matters

A lot of crypto infrastructure today is built around moving messages or minting representations of assets. That is useful, but it is not the same thing as control.

A wrapped asset gives you an IOU.  
A bridge gives you a message.  
A custody provider gives you delegated trust.

SolSig gives you something different:

**programmatic signing authority.**

That means a Solana program can do more than reference assets on another chain. It can actually control them according to on-chain rules.

This is the unlock.

## The simplest way to think about it

Phantom and MetaMask are wallets for people.

SolSig is a wallet primitive for smart contracts.

A person can hold a seed phrase and click Sign.  
A program cannot.

That is why autonomous vaults, DAOs, agents, and policy-driven protocols still break down the moment they need to act outside Solana. They hit a boundary where code stops and human key management begins.

SolSig moves that boundary.

## Why not just use a bridge?

Because a bridge solves a different problem.

A bridge usually does one of two things:

1. locks an asset on one chain and issues a wrapped representation on another,
2. or relays a message so one chain can act on information from another.

SolSig does neither.

We do not mint a synthetic asset.  
We do not ask a foreign chain to trust a cross-chain attestation.

We ask a signing committee to produce a valid signature for a transaction that the foreign chain can verify with its ordinary rules.

From Bitcoin’s perspective, this is just a valid Bitcoin signature.  
From Ethereum’s perspective, this is just a valid secp256k1 signature.

That is why SolSig is better understood as a **signing layer** than as a traditional bridge.

## What this unlocks

SolSig enables applications that are hard or impossible to build cleanly today.

### 1. Native-BTC vaults controlled by Solana logic

A Solana vault can hold BTC at a deterministically derived external address and spend it through program policy, instead of relying on a custodian or wrapped asset.

### 2. Autonomous hedging on external venues

A Solana treasury or strategy can rebalance or hedge on an external chain without waiting for a human signer or handing keys to a SaaS custody provider.

### 3. Cross-chain agents

An on-chain agent can operate with BTC, ETH, and SOL under one policy engine, rather than splitting authority across a smart contract on one chain and human-managed wallets on others.

### 4. New BTC-backed products

Developers can build products on top of SolSig instead of just integrating existing wrapped BTC systems. SolSig is a primitive, not just one packaged product.

## Why now

The timing is good because several trends are converging:

- Solana is becoming a stronger execution environment for trading, agents, and consumer apps.
- Demand for Bitcoin-on-Solana exposure is already proven.
- More teams want programmable policy and automation, not more manual signing flows.
- Existing cross-chain solutions still carry visible custody, bridge, and operational risk.

In other words, the application layer is ready for this primitive now.

## Why this is a good hackathon project

A strong hackathon project needs three things:

1. a real missing primitive,
2. a clear demo,
3. and a believable path to becoming a startup.

SolSig has all three.

### The missing primitive

“Solana programs cannot natively sign on Bitcoin or Ethereum” is a concrete gap.

### The demo

The demo is simple and powerful:

**a Solana program spends a real Bitcoin testnet UTXO through one CPI call.**

That is instantly understandable, even to someone who has not read the whole architecture.

### The startup path

If the primitive works, other protocols can integrate it. That gives SolSig a credible infrastructure wedge rather than a one-off feature demo.

## Honest limitations

The MVP is not trustless, and we should not pretend otherwise.

Today’s version uses an off-chain signer committee. The long-term roadmap is to harden the model with threshold signing, stronger committee design, and better economic security.

That means the right claim is not:

> “We solved cross-chain trust forever.”

The right claim is:

> “We proved that Solana programs can control external-chain assets through a clean signing primitive.”

That is already meaningful.

## The main risk

The hardest question for SolSig is not novelty. It is trust.

Anyone evaluating the project seriously will ask:

- why should this committee be trusted,
- what prevents collusion,
- what happens if signers go offline,
- how does security scale with value secured,
- and how do you keep the signing flow policy-safe?

Those are real questions. They do not kill the idea, but they define the roadmap.

That is why SolSig should be pitched first as a new primitive and a working developer experience, not as a finished trust-minimized system.

## Competitive framing

The clearest way to position SolSig is:

- **wrapped BTC products** are products,
- **bridges** are transport layers,
- **wallets like Phantom** are for humans,
- **SolSig** is a signing primitive for programs.

That is the real differentiation.

The best comparison is not “we are another version of cbBTC or zBTC.”  
The best comparison is “we are the primitive other teams could build on instead of depending entirely on those systems.”

## Why the idea is strong

The strongest version of the SolSig thesis is not “all bridges are dead.”

It is this:

> Smart contracts still lack a native way to control external-chain assets. SolSig turns that missing capability into infrastructure.

That is a serious idea.

It is technically ambitious, easy to demonstrate, strategically useful, and broad enough to matter beyond a single app.

## Long-term vision

If SolSig works, Solana programs stop being local-only applications.

They become policy engines that can control assets across chains through signatures, not just through wrapped representations or trusted operators.

That is the long-term vision:

**Solana as the place where program logic lives, even when the assets live elsewhere.**

## One-line conclusion

**SolSig gives Solana programs a native signing primitive for Bitcoin and Ethereum, so smart contracts can control real external-chain assets instead of depending on wrapped tokens, bridge vaults, or human signers.**