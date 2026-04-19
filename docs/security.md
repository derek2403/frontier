# Security Model

SolSig is a cross-chain signing primitive for Solana programs.

It lets a Solana program request a valid secp256k1 signature for Bitcoin, Ethereum, or another ECDSA chain. That is powerful, but it also means security has to be explained clearly.

This document describes what SolSig does, what it assumes, what the current MVP does **not** guarantee, and how the security model is intended to evolve.

## Security goal

The goal of SolSig is not to eliminate trust completely.

The goal is to replace today’s common cross-chain trust patterns — custodians, human signers, and lock-and-mint bridge designs — with a cleaner model where:

- signing authority is requested by Solana program logic,
- external addresses are deterministically tied to program identity,
- and signing is performed by a committee rather than a single private key.

In other words, SolSig aims to make cross-chain control **programmable**, **auditable**, and eventually **economically secured**.

## What SolSig guarantees

At a high level, SolSig guarantees the following:

1. A Solana program can request a signature through a defined CPI interface.
2. The external-chain address is deterministically derived from the caller’s `program_id` and seeds.
3. A valid secp256k1 signature is returned only after the signing flow completes successfully.
4. The foreign chain verifies the signature using its normal rules.

This means the foreign chain does not need to understand Solana, verify bridge attestations, or trust a wrapped-token issuer.

## What SolSig does **not** guarantee

The MVP does **not** claim to be trustless.

It does not eliminate all off-chain assumptions.  
It does not guarantee censorship resistance.  
It does not guarantee instant finality across chains.  
It does not guarantee production-grade threshold security in its earliest form.

The correct framing is:

> SolSig reduces reliance on human wallets, custodians, and wrapped-token systems by moving cross-chain authority into program logic and committee signing.

That is a meaningful improvement, but it is not magic.

## Current MVP trust model

The current MVP uses an off-chain signer committee.

That means the MVP depends on a bounded set of signers behaving correctly and remaining available. In practical terms, the system inherits the following assumptions:

- signers do not collude to sign unauthorized payloads,
- signers remain online often enough for requests to complete,
- the request flow is implemented correctly,
- and the upgrade / operator process is controlled responsibly.

This is acceptable for a hackathon MVP, but it should be read as a prototype trust model, not as the final one.

## Main security assumptions

### 1. Committee honesty

SolSig assumes the signer committee only signs requests that originated from the expected Solana-side flow.

If the committee signs payloads it should not sign, users and protocols can be harmed.

This is the most important trust assumption in the MVP.

### 2. Committee liveness

If enough signers are unavailable, signing can stall.

That means SolSig has both a **safety** requirement and a **liveness** requirement:

- safety: do not sign bad requests,
- liveness: do sign valid requests in time.

Both matter.

### 3. Correct request construction

The calling program must construct the payload to be signed correctly.

If a caller builds the wrong sighash, wrong chain payload, wrong nonce, or wrong expiry, SolSig may faithfully sign a payload the application did not intend.

In that case, the problem is not “bad cryptography.” The problem is incorrect request construction by the integrating application.

### 4. Upgrade authority discipline

If the SolSig program or critical off-chain components can still be upgraded, those upgrade paths must be treated as high-trust surfaces.

An upgrade key with broad authority is effectively a security-critical role.

## Main risk categories

## 1. Unauthorized signing

The worst-case failure mode is unauthorized signing.

That could happen through:

- committee collusion,
- a compromised signer process,
- a bad operator workflow,
- or a bug in request validation.

Mitigations include:

- strict request validation,
- narrow payload formats,
- replay protection,
- expiry / TTL enforcement,
- and eventually stronger threshold and slashing mechanisms.

## 2. Liveness failure

A valid request may fail to complete if signers are offline or slow.

This does not necessarily lose funds, but it can break application flows and degrade reliability.

Mitigations include:

- signer redundancy,
- timeout / cancellation flows,
- monitoring,
- and clearer recovery procedures for stalled requests.

## 3. Replay or stale signing

If payloads do not include proper replay protection, a valid signature can be reused in an unintended context.

Mitigations include:

- per-request nonces,
- chain-specific domain separation,
- expiry windows,
- and application-level state tracking.

## 4. Caller-side bugs

SolSig is a primitive. That means applications integrating it can still make mistakes.

Examples include:

- malformed Bitcoin sighashes,
- signing the wrong transaction fields,
- missing expiries,
- wrong derivation seeds,
- or unsafe business logic around withdrawals.

SolSig cannot fully protect applications from incorrect usage. Integrators must treat the signing payload as security-critical.

## 5. Upgrade and operator risk

Even if the cryptography is sound, real systems can fail through deployment or operator mistakes.

Examples include:

- insecure key handling,
- poor signer isolation,
- bad ceremony processes,
- or unsafe operational access.

This is why operational security matters as much as protocol design.

## Why this is still better than the default alternative

The most important comparison is not “is SolSig trustless?”

The important comparison is:

> Is SolSig a better security shape than the common alternatives available to Solana protocols today?

In many cases, the answer is yes.

### Compared to a human signer

A human signer creates a single operational chokepoint:

- one wallet,
- one device,
- one approval path,
- one compromise away from failure.

SolSig replaces that with program-triggered signing and a committee-based model.

### Compared to a custodian

A custodian introduces organizational, legal, and operational concentration.

You are trusting a company to remain solvent, compliant, available, and honest.

SolSig replaces that with protocol and committee assumptions rather than pure corporate custody.

### Compared to a wrapped-token / bridge design

Wrapped-token systems and bridge systems often rely on pooled custody, message verification, or validator attestations.

SolSig does not ask the foreign chain to verify that “Solana said something happened.”  
It asks the foreign chain to verify an ordinary signature.

That does not remove all trust, but it removes an entire class of bridge-style assumptions.

## Why the MVP is still worth shipping

The MVP is valuable because it proves three things:

1. the primitive is technically possible,
2. the developer experience is real,
3. and applications can be built around it.

That is enough for a hackathon and enough to justify deeper investment in hardening the system.

The MVP should be judged as a proof of primitive, not as the finished security endpoint.

## Roadmap to a stronger security model

The intended path is:

### 1. Better threshold signing

Move from the earliest committee model toward stronger threshold signing, so no single operator or small subset can unilaterally act.

### 2. Stronger request validation

Constrain payload formats and make replay protection, expiry handling, and domain separation mandatory.

### 3. Better operator security

Harden key handling, isolation, monitoring, and failure recovery procedures.

### 4. Economic security

Move toward a model where committee members have explicit economic downside for misbehavior or non-performance.

### 5. Reduced upgrade trust

Timelocks, governance, limited upgrade scope, or eventual immutability can reduce trust in privileged roles over time.

## Honest summary

SolSig is not “trustless Bitcoin on Solana.”

It is a cleaner primitive for cross-chain authority.

The MVP still relies on a signer committee. That is a real trust assumption and should be stated openly. But the architecture moves the system in an important direction:

- away from human click-sign flows,
- away from centralized custody,
- away from lock-and-mint bridge assumptions,
- and toward programmable, policy-driven cross-chain control.

That is the security thesis.

## One-line takeaway

**SolSig’s security model is: program-driven requests, deterministic external identities, committee-based signing today, and stronger threshold + economic security over time.**