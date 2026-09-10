---
description: Use this when the user wants a Solana program to sign external-chain (Ethereum, Sui, Bitcoin, any secp256k1/ECDSA chain) transactions via SODA (Solana-Owned Derived Authority) — i.e. build cross-chain dApps where a Solana PDA controls a foreign-chain address. Triggers on phrases like "use SODA", "@soda-sdk/core", "Solana-Owned Derived Authority", "Solana program signs an Ethereum tx", "Solana wallet owns a Sui address", or "Solana PDA controls a Bitcoin UTXO".
allowed-tools: Bash(pnpm *), Bash(npm *), Bash(yarn *)
---

# SODA: Solana-Owned Derived Authority

SODA gives any Solana program a CPI primitive that returns a valid `secp256k1` signature for Ethereum, Sui, Bitcoin, or any chain that verifies ECDSA. The foreign-chain address is deterministically derived from the caller's `(program_id, seeds)` — so a Solana PDA literally owns the foreign address. No wrapped tokens, no bridge, no custodian.

The TypeScript SDK is published as [`@soda-sdk/core`](https://www.npmjs.com/package/@soda-sdk/core).

## When to use this skill

Invoke when the user wants to:
- Sign an Ethereum / Sui / Bitcoin / generic ECDSA transaction from Solana program logic.
- Derive a deterministic foreign-chain address for a Solana PDA.
- Build cross-chain DeFi without bridges or wrapped tokens.
- Use `@soda-sdk/core` in a Node, Next.js, or Vite project.

Do NOT invoke for: ordinary Solana wallet flows, SPL tokens, or chains that only verify Ed25519 (Aptos, Solana itself, NEAR-native accounts). Sui counts as ECDSA: it accepts secp256k1 natively under scheme flag `0x01`, which is why it works with the same key. See the Sui section below.

## Architecture in one diagram

```
caller program  --CPI-->  soda program  --emit SigRequested-->  off-chain signer
                                                                       |
caller program  --emit EthTxRequested-->  relayer                      |
                                                                       v
                                              soda program <--finalize_signature-- signer
                                                       |
                                                       +--emit SigCompleted--> relayer
                                                                                  |
                                                                                  v
                                                                                  Sepolia / etc
```

## Step-by-step build

### Step 1: Install

```bash
pnpm add @soda-sdk/core @solana/web3.js @noble/hashes
```

`@noble/hashes` is needed for `keccak256`. SDK is ESM-only.

### Step 2: Read the committee public key

The committee's aggregate `group_pk` lives in a `Committee` PDA on the deployed `soda` program (devnet `2YDHaX2fPXdmH14hgSJQHMJQpEHrXofzhu5hDVFgFiVd`).

```ts
import { Connection, PublicKey } from '@solana/web3.js'

const SODA_PROGRAM_ID = new PublicKey('2YDHaX2fPXdmH14hgSJQHMJQpEHrXofzhu5hDVFgFiVd')
const conn = new Connection('https://api.devnet.solana.com')
const [committeePda] = PublicKey.findProgramAddressSync(
  [Buffer.from('committee')], SODA_PROGRAM_ID,
)
const acct = await conn.getAccountInfo(committeePda)
if (!acct) throw new Error('Committee not initialized')

// First 8 bytes = Anchor discriminator. Next 64 bytes = group_pk_xy (X || Y).
const xy = acct.data.subarray(8, 8 + 64)
const x = xy.subarray(0, 32)
const y = xy.subarray(32, 64)
const groupPkCompressed = new Uint8Array(33)
groupPkCompressed[0] = (y[31] & 1) === 1 ? 0x03 : 0x02
groupPkCompressed.set(x, 1)
```

### Step 3: Derive your foreign-chain address

```ts
import { deriveEthAddress, ETH_SEPOLIA_CHAIN_TAG } from '@soda-sdk/core'

const callerProgramId = new PublicKey('YourProgramID...').toBytes()
const seeds = new Uint8Array(0) // any per-request bytes; PDA seeds work great

const { ethAddress, foreignPk } = deriveEthAddress(
  groupPkCompressed,
  callerProgramId,
  seeds,
  ETH_SEPOLIA_CHAIN_TAG,
)
console.log('ETH address:', '0x' + Buffer.from(ethAddress).toString('hex'))
```

The result is deterministic. Same inputs, same address. Fund it once on Sepolia, demo forever.

### Step 4: Build the unsigned transaction

```ts
import { encodeUnsignedLegacy, bigintToBe, EthRpc, type LegacyTx } from '@soda-sdk/core'
import { keccak_256 } from '@noble/hashes/sha3'

const rpc = new EthRpc(process.env.SEPOLIA_RPC_URL!)
const fromAddrHex = '0x' + Buffer.from(ethAddress).toString('hex')
const nonce = await rpc.getNonce(fromAddrHex)
const gasPrice = await rpc.getGasPrice()

const tx: LegacyTx = {
  nonce,
  gasPriceWei: gasPrice,
  gasLimit: 21_000n,
  to: ethAddress, // Uint8Array(20)
  valueWeiBe: bigintToBe(100_000_000_000_000n, 32), // 0.0001 ETH
  data: new Uint8Array(),
  chainId: 11155111n, // Sepolia
}

const unsignedRlp = encodeUnsignedLegacy(tx)
const payloadHash = keccak_256(unsignedRlp) // 32 bytes — what gets signed
```

### Step 5: Request the signature on Solana

Two shapes — pick whichever matches the user's setup.

**5a. CPI from your own Anchor program (production shape):**

```rust
use soda::cpi::accounts::RequestSignature;
use soda::cpi::request_signature;

let cpi_ctx = CpiContext::new(
    ctx.accounts.soda_program.to_account_info(),
    RequestSignature {
        sig_request: ctx.accounts.sig_request.to_account_info(),
        committee:   ctx.accounts.committee.to_account_info(),
        payer:       ctx.accounts.payer.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    },
);
request_signature(cpi_ctx, foreign_pk_xy, seeds, payload_hash, chain_tag)?;
```

**5b. Client-side direct ix (demo / testing):**

```ts
const foreignPkXy = foreignPk.subarray(1) // strip 0x04 prefix → 64 bytes

await sodaProgram.methods
  .requestSignature(
    Array.from(foreignPkXy),
    Buffer.from(seeds),
    Array.from(payloadHash),
    Buffer.from(ETH_SEPOLIA_CHAIN_TAG),
  )
  .accounts({ /* sig_request PDA, committee, payer */ })
  .rpc()
```

### Step 6: Wait for `SigCompleted`

```ts
const SIG_COMPLETED_DISC = sha256('event:SigCompleted').slice(0, 8)

function waitForSigCompleted(conn, sigRequestPda) {
  return new Promise((resolve, reject) => {
    const subId = conn.onLogs(SODA_PROGRAM_ID, (logs) => {
      for (const line of logs.logs) {
        if (!line.startsWith('Program data: ')) continue
        const data = Buffer.from(line.slice('Program data: '.length), 'base64')
        if (!data.subarray(0, 8).equals(SIG_COMPLETED_DISC)) continue
        const requestPk = new PublicKey(data.subarray(8, 40))
        if (!requestPk.equals(sigRequestPda)) continue
        const signature = new Uint8Array(data.subarray(40, 40 + 64))
        const recoveryId = data[40 + 64]
        conn.removeOnLogsListener(subId).then(() => resolve({ signature, recoveryId }))
        return
      }
    })
    setTimeout(() => reject(new Error('Timed out')), 30_000)
  })
}
```

### Step 7: Assemble and broadcast

```ts
import { encodeSignedLegacy, eip155V } from '@soda-sdk/core'

const { signature, recoveryId } = await waitForSigCompleted(conn, sigRequestPda)
const r = signature.subarray(0, 32)
const s = signature.subarray(32, 64)
const v = eip155V(recoveryId, tx.chainId)

const signedRlp = encodeSignedLegacy(tx, v, r, s)
const txHash = await rpc.sendRawTransaction('0x' + Buffer.from(signedRlp).toString('hex'))
console.log('https://sepolia.etherscan.io/tx/' + txHash)
```

## Sui: the second chain family

Use this path when the user names Sui, MIST, a `0x…` 64-hex address, Move / PTBs, or `DEMO_CHAIN=sui-testnet`. Steps 2, 6 and the `soda` program are identical to the Ethereum path; only steps 3, 4, 5 and 7 change. Sui verifies secp256k1 under scheme flag `0x01`, so the committee's ordinary ECDSA output is a valid Sui user signature once wrapped.

The three formulas (all implemented in `@soda-sdk/core` and twinned in the `sui_demo` program):

```
address  = blake2b256(0x01 || compressed_pk)                          32 bytes, shown as 0x + 64 hex
payload  = sha256(blake2b256(0x00 0x00 0x00 || bcs(TransactionData))) what the committee signs; what soda stores
sig      = base64(0x01 || r || s || compressed_pk)                     98 bytes, submitted next to the tx bytes
```

The digest explorers show is a different hash: `base58(blake2b256("TransactionData::" || bcs))`.

**SDK calls, in order:**

```ts
import {
  deriveSuiAddress, bytesToHex0x, SUI_CHAINS, SuiGraphQl, suiGraphqlUrl,
  encodeSuiTransferKind, encodeSuiTransactionData, suiSigningPayload, suiTransactionDigest,
  encodeSuiSignature, compressPk, parseSuiAddress,
  SUI_DEMO_AMOUNT_MIST, SUI_TRANSFER_GAS_BUDGET_MIST, SUI_MIN_BALANCE_MIST, SUI_MAX_GAS_COINS,
} from '@soda-sdk/core'

const CHAIN = SUI_CHAINS['sui-testnet']                    // or 'sui-devnet'; chainTag = tag32("sui-testnet")
const sui = new SuiGraphQl(suiGraphqlUrl(CHAIN))           // https://graphql.testnet.sui.io/graphql, CORS-open, no key

// 1. Derive. The owner is the Solana SIGNER of the request (wallet pubkey or PDA), not a program id.
const { foreignPk, suiAddress } = deriveSuiAddress(groupPkCompressed, owner, seeds, CHAIN.chainTag)
const addr = bytesToHex0x(suiAddress)

// 2. Fund: needs >= SUI_MIN_BALANCE_MIST (0.02 SUI). Faucet: POST https://faucet.testnet.sui.io/v2/gas
//    { "FixedAmountRequest": { "recipient": addr } }  (429 "Wait for Ns" is common; web: https://faucet.sui.io)

// 3. Build. Gas = the sender's own SUI coin objects (id, version, digest); no nonce.
const coins = (await sui.getGasCoins(addr)).slice(0, SUI_MAX_GAS_COINS)   // largest first
const gasPrice = await sui.getReferenceGasPrice()
const kindBytes = encodeSuiTransferKind(parseSuiAddress(recipientHex), SUI_DEMO_AMOUNT_MIST)
//   arbitrary PTB instead: await new Transaction()....build({ onlyTransactionKind: true })  (@mysten/sui)
const txBytes = encodeSuiTransactionData({ kindBytes, sender: suiAddress, gasPayment: coins.map(c => c.ref), gasPrice, gasBudget: SUI_TRANSFER_GAS_BUDGET_MIST })
const payload = suiSigningPayload(txBytes)          // 32 bytes -> soda
const digest = suiTransactionDigest(txBytes)        // base58 -> https://suiscan.xyz/testnet/tx/<digest>
const sim = await sui.simulate(txBytes)             // dry-run BEFORE paying for Solana txs
if (sim.status !== 'SUCCESS') throw new Error(sim.error ?? 'dry-run failed')

// 4. Request on Solana through sui_demo (below). 5. waitForSigCompleted as in step 6 above.

// 6. Attach and execute (waits for finality).
const sig = encodeSuiSignature(signature, compressPk(foreignPk))
const exec = await sui.executeTransaction(txBytes, [sig])   // { digest, status: 'SUCCESS' | 'FAILURE', error }
```

**Request on Solana via `sui_demo`** (`9LBE5dntoLRV61AM3W3ZHikgZPqZ5MLS4xCVvSxxbXug`; `demo.sh` deploys it wherever it is missing, devnet deploy pending as of 2026-09-10). Sui signs over the sender, so the program derives the signer's Sui address on-chain, BCS-encodes the same bytes, hashes, and CPIs `soda::request_signature`. The client never passes an address.

```ts
// sign_sui_transfer(recipient: [u8;32], amount_mist: u64, gas_payment: Vec<SuiObjectRef>, gas_price: u64,
//                   gas_budget: u64, chain_tag: [u8;32], derivation_seeds: bytes)
// sign_sui_tx(kind_bytes: bytes /* first byte 0x00, <= 768 */, gas_payment, gas_price, gas_budget, chain_tag, derivation_seeds)
// SuiObjectRef = { object_id: [u8;32], version: u64, digest: [u8;32] /* base58-decoded */ }; 1..=4 refs
const [sigRequestPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('sig'), wallet.publicKey.toBuffer(), Buffer.from(payload)], SODA_PROGRAM_ID)

await suiDemo.methods
  .signSuiTransfer(
    Array.from(parseSuiAddress(recipientHex)),
    new BN(SUI_DEMO_AMOUNT_MIST.toString()),
    coins.map(c => ({ objectId: Array.from(c.ref.objectId), version: new BN(c.ref.version.toString()), digest: Array.from(c.ref.digest) })),
    new BN(gasPrice.toString()),
    new BN(SUI_TRANSFER_GAS_BUDGET_MIST.toString()),
    Array.from(CHAIN.chainTag),
    Buffer.from(seeds),
  )
  .accounts({ user: wallet.publicKey, committee: committeePda, sigRequest: sigRequestPda, sodaProgram: SODA_PROGRAM_ID, systemProgram: SystemProgram.programId })
  .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])  // two derivations + blake2b
  .rpc()
```

Event: `SuiTxRequested { sig_request: Pubkey, sender: [u8;32], tx_bytes: bytes }` — `apps/relayer` caches `tx_bytes`, then on `SigCompleted` recovers `pk` from the signature, checks `blake2b256(0x01 || pk) == sender`, attaches `0x01 || sig || pk` and calls `executeTransaction` (`SUI_CHAIN=sui-devnet` to target devnet). The web app's `/sui` page does the same through `/api/sui/finalize` after Phantom signs.

From your own Anchor program: `soda::derive_onchain::{compute_tweak, derive_foreign_pk_xy}` give the sender; copy `sui_bcs.rs` + `blake2b.rs` from `contracts/programs/sui_demo/src/` (Solana has no blake2b syscall). CPI `request_signature(ctx, derivation_seeds, payload, chain_tag, 0)`.

Audit: `pnpm verify:sui <digest>` (`apps/demo/src/verify-sui.ts`). Reference client: `apps/demo/src/demo-sui.ts`; `DEMO_CHAIN=sui-testnet ./demo.sh` runs it.

## API at a glance

| Function | Returns | Notes |
| --- | --- | --- |
| `computeTweak(programId, seeds, chainTag)` | `Uint8Array` (32) | `sha256("SODA-v1" \|\| programId \|\| seeds \|\| chainTag)` |
| `deriveForeignPk(groupPkCompressed, tweak)` | `Uint8Array` (65) | Uncompressed `0x04 \|\| X \|\| Y` |
| `ethAddressFromPk(uncompressedPk)` | `Uint8Array` (20) | `keccak256(pk[1..])[12..]` |
| `deriveEthAddress(groupPk, programId, seeds, chainTag)` | `{ tweak, foreignPk, ethAddress }` | Convenience |
| `encodeUnsignedLegacy(tx: LegacyTx)` | `Uint8Array` | RLP for sighash |
| `encodeSignedLegacy(base, v, r, s)` | `Uint8Array` | RLP for broadcast |
| `decodeUnsignedLegacy(rlp)` | `LegacyTx` | Inverse of unsigned encoder |
| `eip155V(recoveryId, chainId)` | `bigint` | `recoveryId + 35 + 2*chainId` |
| `class EthRpc(url)` | — | `getBalance`, `getNonce`, `getGasPrice`, `sendRawTransaction`, generic `call<T>` |
| `chainFamily(key)` | `"evm" \| "sui"` | Which encoder a `DEMO_CHAIN` key needs; `CHAINS` / `getChain` for EVM, `SUI_CHAINS` / `getSuiChain` for Sui |
| `SUI_CHAINS`, `getSuiChain(key)`, `suiGraphqlUrl(chain)` | `SuiChain` / `string` | `sui-testnet` (default), `sui-devnet`: `chainTag`, GraphQL URL + env override, faucet, explorer URLs |
| `compressPk(pk)` | `Uint8Array` (33) | SEC1 compressed from 65 or 33 bytes |
| `suiAddressFromPk(pk)` | `Uint8Array` (32) | `blake2b256(0x01 \|\| compressed)` |
| `deriveSuiAddress(groupPk, owner, seeds, chainTag)` | `{ tweak, foreignPk, suiAddress }` | Convenience |
| `parseSuiAddress(hex)` / `bytesToHex0x(b)` | `Uint8Array` (32) / `string` | Sui address / object id parsing (pads `0x2`), `0x` hex printing |
| `encodeSuiTransferKind(recipient, amountMist)` | `Uint8Array` | BCS PTB: `SplitCoins(GasCoin, [amount])` + `TransferObjects` |
| `encodeSuiTransactionData({ kindBytes, sender, gasPayment, gasOwner?, gasPrice, gasBudget })` | `Uint8Array` | BCS `TransactionData::V1`; equals `@mysten/sui` `Transaction.build()` |
| `suiSigningPayload(txBytes)` | `Uint8Array` (32) | `sha256(blake2b256(intent \|\| tx))`: what soda stores |
| `suiIntentDigest(txBytes)` / `suiIntentMessage(txBytes)` | `Uint8Array` | `blake2b256(intent \|\| tx)` / the preimage |
| `suiTransactionDigest(txBytes)` | `string` (base58) | What explorers show |
| `encodeSuiSignature(sig64, pk)` / `decodeSuiSignature(bytes)` | `Uint8Array` (98) / `{ flag, signature, publicKey }` | `0x01 \|\| r \|\| s \|\| pk` |
| `signSuiTransactionWithSecp256k1(txBytes, sk)` | `{ signatureB64, recoveryId }` | Raw-key signing (gas sponsor); the committee never calls this |
| `parseSuiPrivateKey(input)` → `suiAddressFromKey(key)`, `signSuiTransactionWithKey(txBytes, key)` | `SuiSigningKey` / `Uint8Array` (32) / `{ serialized, signatureB64 }` | Sponsor keys as people have them: a `suiprivkey1…` export (Ed25519 or secp256k1) or 32-byte hex (secp256k1). `SUI_FUNDER_KEY` takes either |
| `class SuiGraphQl(url)` | — | `getBalance`, `getGasCoins`, `getReferenceGasPrice`, `simulate`, `executeTransaction`, `getTransaction`, `getChainIdentifier`, generic `query<T>` |
| `requestSuiFromFaucet(url, addr)` | `{ ok, status, body }` | 429 is reported, not thrown |
| `toBase58` / `fromBase58`, `toBase64` / `fromBase64` | — | Sui digest and wire encodings, no `Buffer` |
| `SUI_DEMO_AMOUNT_MIST`, `SUI_TRANSFER_GAS_BUDGET_MIST`, `SUI_MIN_BALANCE_MIST`, `SUI_SPONSOR_MAX_TOPUP_MIST`, `SUI_MAX_GAS_COINS`, `MIST_PER_SUI` | `bigint` / `number` | 0.001 SUI, 0.01 SUI, 0.02 SUI, 0.1 SUI, 4, 1e9 |

`LegacyTx`:
```ts
{ nonce: bigint, gasPriceWei: bigint, gasLimit: bigint,
  to: Uint8Array(20), valueWeiBe: Uint8Array, data: Uint8Array, chainId: bigint }
```

`SuiObjectRef` / `SuiTxEnvelope`:
```ts
{ objectId: Uint8Array(32), version: bigint, digest: Uint8Array(32) }
{ kindBytes: Uint8Array, sender: Uint8Array(32), gasPayment: SuiObjectRef[], gasOwner?: Uint8Array(32), gasPrice: bigint, gasBudget: bigint }
```

## Two committee modes (v0 vs v0.5)

SODA ships two off-chain signer implementations. Pick whichever suits the
user's needs — the on-chain program treats both identically.

**v0 — single-key signer.** One Rust daemon (`pnpm signer`) with a 32-byte
k256 secret in `keyshare.dev.json`. Simplest path; what `./demo.sh` uses
by default. Fine for hackathon-style throwaway demos. Trust assumption:
the dev key on disk is honest.

**v0.5 — Lindell '17 2-of-2 MPC ECDSA (shipped 2026-05-11).** Real
threshold ECDSA across two `apps/mpc-node` services. Neither node sees
`group_sk`. To run:

```bash
pnpm mpc:dkg                  # once: distributed key generation
pnpm mpc:up                   # docker compose: 2 nodes + coordinator
pnpm mpc:update-committee     # once: swap on-chain group_pk
pnpm mpc:subscribe            # subscriber loop replaces `pnpm signer`
./demo.sh                     # signing now goes through MPC
```

The architecture:

```
caller program → SigRequested → mpc-subscriber
                                     │ POST /sign
                                     ▼
                       mpc-coordinator (drives 4-msg protocol)
                              /                 \
                             ▼                   ▼
                   mpc-node-p1            mpc-node-p2
                   (holds x1)             (holds x2)
                              \                 /
                               r,s,v ← combined sig
                                     │
                                     ▼
                       soda::finalize_signature  (no on-chain change)
```

Choose v0.5 when explaining the trust model to the user. The on-chain
program does NOT change — same `secp256k1_recover` syscall verifies
both v0 and v0.5 signatures, for Ethereum and Sui alike.

## Common errors

| Error | Cause | Fix |
| --- | --- | --- |
| `insufficient funds` | Derived address has no Sepolia ETH | Send a few cents from a faucet to the address from step 3 |
| `nonce too low` | Two clients raced and both broadcast | Idempotent: the other won, just re-read state |
| `AlreadyCompleted` (custom error 0x1770) | Some other client already finalized | Treat as success, read on-chain `SigRequest` |
| `SignatureMismatch` (0x1771) | Caller passed wrong `foreign_pk_xy` | Re-derive with `deriveForeignPk` |
| Sui faucet `429 Wait for Ns` | Public faucet rate-limits per IP | Wait, use https://faucet.sui.io, or a `SUI_FUNDER_KEY` sponsor; keep polling `getBalance` |
| `no SUI coin objects at 0x…` | Unfunded, or the GraphQL indexer has not seen the transfer yet | Check Suiscan, retry in a few seconds |
| Sui `FAILURE` / stale object version | A gas coin's `(version, digest)` changed after it was read (a top-up landed) | Refetch `getGasCoins`, rebuild `txBytes`; new payload = new `SigRequest` |
| `NotProgrammable` / `KindTooLong` / `BadGasPayment` (`sui_demo` 0x1770–0x1772) | `kind_bytes` not starting with `0x00` / over 768 bytes / 0 or more than 4 gas refs | `build({ onlyTransactionKind: true })`; slice coins to `SUI_MAX_GAS_COINS` |

## Defaults to assume

- **Network:** Solana devnet for SODA; Sepolia for ETH; `sui-testnet` for Sui (public GraphQL `https://graphql.testnet.sui.io/graphql`, no key). Mainnet not deployed in v0.
- **Package manager:** pnpm preferred. npm/yarn work too.
- **Module system:** ESM only. Use `"type": "module"` in `package.json` or import via Node ESM.
- **Hashes:** Use `@noble/hashes/sha3` for `keccak_256`. Do not invent. For Sui the SDK does the blake2b / sha256 itself; `@mysten/sui` is only needed to build arbitrary PTB kinds.

## When a user just wants to *try* SODA

Don't have them build from scratch. Tell them to clone the reference repo and run the demo:

```bash
git clone https://github.com/derek2403/frontier
cd frontier
pnpm install
cp .env.example .env  # fill SEPOLIA_RPC_URL (and SUI_FUNDER_KEY, optional, for Sui)
./demo.sh                         # Ethereum / Base
DEMO_CHAIN=sui-testnet ./demo.sh  # Sui
```

This produces a real Sepolia tx in about 10 seconds, or a Sui testnet transfer from the wallet's derived Sui address.

## Reference

- npm: https://www.npmjs.com/package/@soda-sdk/core
- Docs site: run `pnpm docs:dev` from the cloned repo and open http://localhost:3001
- Long-form walkthroughs: `apps/docs/pages/guides/sign-an-eth-tx.mdx`, `apps/docs/pages/guides/sign-a-sui-tx.mdx`
- On-chain programs: `contracts/programs/soda/src/lib.rs`, `contracts/programs/sui_demo/src/lib.rs`
- Sui encoder + parity tests: `packages/soda-sdk/src/sui.ts`, `sui.test.ts`
