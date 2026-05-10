---
description: Use this when the user wants to sign external-chain (Ethereum, Bitcoin, any ECDSA chain) transactions from a Solana program — i.e. build cross-chain dApps where a Solana PDA controls a foreign-chain address. Triggers on phrases like "use SODA", "@soda-sdk/core", "chain signatures from Solana", "Solana program signs an Ethereum tx", or "Solana PDA controls a Bitcoin UTXO".
allowed-tools: Bash(pnpm *), Bash(npm *), Bash(yarn *)
---

# SODA: Chain signatures for Solana

SODA gives any Solana program a CPI primitive that returns a valid `secp256k1` signature for Bitcoin, Ethereum, or any ECDSA chain. The foreign-chain address is deterministically derived from the caller's `(program_id, seeds)` — so a Solana PDA literally owns the foreign address. No wrapped tokens, no bridge, no custodian.

The TypeScript SDK is published as [`@soda-sdk/core`](https://www.npmjs.com/package/@soda-sdk/core).

## When to use this skill

Invoke when the user wants to:
- Sign an Ethereum / Bitcoin / generic ECDSA transaction from Solana program logic.
- Derive a deterministic foreign-chain address for a Solana PDA.
- Build cross-chain DeFi without bridges or wrapped tokens.
- Use `@soda-sdk/core` in a Node, Next.js, or Vite project.

Do NOT invoke for: ordinary Solana wallet flows, SPL tokens, or non-ECDSA chains.

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

The committee's aggregate `group_pk` lives in a `Committee` PDA on the deployed `soda` program (devnet `99apYWpnoMWwA2iXyJZcTMoTEag6tdFasjujdhdeG8b4`).

```ts
import { Connection, PublicKey } from '@solana/web3.js'

const SODA_PROGRAM_ID = new PublicKey('99apYWpnoMWwA2iXyJZcTMoTEag6tdFasjujdhdeG8b4')
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

`LegacyTx`:
```ts
{ nonce: bigint, gasPriceWei: bigint, gasLimit: bigint,
  to: Uint8Array(20), valueWeiBe: Uint8Array, data: Uint8Array, chainId: bigint }
```

## Common errors

| Error | Cause | Fix |
| --- | --- | --- |
| `insufficient funds` | Derived address has no Sepolia ETH | Send a few cents from a faucet to the address from step 3 |
| `nonce too low` | Two clients raced and both broadcast | Idempotent: the other won, just re-read state |
| `AlreadyCompleted` (custom error 0x1770) | Some other client already finalized | Treat as success, read on-chain `SigRequest` |
| `SignatureMismatch` (0x1771) | Caller passed wrong `foreign_pk_xy` | Re-derive with `deriveForeignPk` |

## Defaults to assume

- **Network:** Solana devnet for SODA; Sepolia for ETH. Mainnet not deployed in v0.
- **Package manager:** pnpm preferred. npm/yarn work too.
- **Module system:** ESM only. Use `"type": "module"` in `package.json` or import via Node ESM.
- **Hashes:** Use `@noble/hashes/sha3` for `keccak_256`. Do not invent.

## When a user just wants to *try* SODA

Don't have them build from scratch. Tell them to clone the reference repo and run the demo:

```bash
git clone https://github.com/derek2403/frontier
cd frontier
pnpm install
cp .env.example .env  # fill SEPOLIA_RPC_URL
./demo.sh
```

This produces a real Sepolia tx in about 10 seconds.

## Reference

- npm: https://www.npmjs.com/package/@soda-sdk/core
- Docs site: run `pnpm docs:dev` from the cloned repo and open http://localhost:3001
- Long-form walkthrough: `apps/docs/pages/guides/sign-an-eth-tx.mdx`
- On-chain program: `contracts/programs/soda/src/lib.rs`
