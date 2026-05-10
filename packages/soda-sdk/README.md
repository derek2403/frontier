# @soda-sdk/core

TypeScript SDK for [SODA](https://github.com/JingYuan0926/frontier): chain
signatures for Solana. Derive foreign-chain addresses from a Solana PDA,
build the payloads to sign, and broadcast the result.

## Install

```bash
pnpm add @soda-sdk/core
# or
npm install @soda-sdk/core
# or
yarn add @soda-sdk/core
```

Bundles `@noble/curves` and `@noble/hashes` as direct deps. ESM only.

## Quick example

```ts
import {
  deriveEthAddress,
  encodeUnsignedLegacy,
  encodeSignedLegacy,
  eip155V,
  bigintToBe,
  EthRpc,
  ETH_SEPOLIA_CHAIN_TAG,
  type LegacyTx,
} from '@soda-sdk/core'
import { keccak_256 } from '@noble/hashes/sha3'

// 1. Derive the ETH address controlled by a Solana PDA.
const { ethAddress, foreignPk } = deriveEthAddress(
  groupPkCompressed,    // 33-byte compressed committee pubkey
  requesterProgramId,   // 32-byte Solana program id
  seeds,                // arbitrary identifying bytes
  ETH_SEPOLIA_CHAIN_TAG,
)

// 2. Build an unsigned Sepolia transaction.
const tx: LegacyTx = {
  nonce: 0n,
  gasPriceWei: 1_000_000_000n,
  gasLimit: 21_000n,
  to: ethAddress,                          // Uint8Array(20)
  valueWeiBe: bigintToBe(100_000_000_000_000n, 32),  // 0.0001 ETH, big-endian
  data: new Uint8Array(),
  chainId: 11155111n,
}

const unsignedRlp = encodeUnsignedLegacy(tx)
const payloadHash = keccak_256(unsignedRlp)

// 3. Pass payloadHash into soda::request_signature on Solana,
//    await SigCompleted, then receive { signature: 64 bytes, recoveryId: 0|1 }.

// 4. Assemble + broadcast.
const r = signature.subarray(0, 32)
const s = signature.subarray(32, 64)
const v = eip155V(recoveryId, tx.chainId)
const signedRlp = encodeSignedLegacy(tx, v, r, s)

const rpc = new EthRpc(process.env.SEPOLIA_RPC_URL!)
const txHash = await rpc.sendRawTransaction(
  '0x' + Buffer.from(signedRlp).toString('hex'),
)
```

## What's exported

**Derivation**

- `computeTweak(programId, seeds, chainTag): Uint8Array` — 32-byte tweak.
- `deriveForeignPk(groupPkCompressed, tweak): Uint8Array` — 65-byte uncompressed.
- `ethAddressFromPk(uncompressedPk): Uint8Array` — 20-byte ETH address.
- `deriveEthAddress(groupPkCompressed, programId, seeds, chainTag)` —
  returns `{ tweak, foreignPk, ethAddress }`.

**Ethereum RLP**

- `encodeUnsignedLegacy(tx: LegacyTx): Uint8Array`
- `encodeSignedLegacy(base, v, r, s): Uint8Array`
- `decodeUnsignedLegacy(rlp): LegacyTx`
- `eip155V(recoveryId, chainId): bigint`
- `type LegacyTx`

**RPC**

- `class EthRpc` with `getBalance`, `getNonce`, `getGasPrice`,
  `sendRawTransaction`, plus a generic `call<T>(method, params)`.

**Helpers**

- `bigintToBe(n, len)`, `bytesToBigInt(b)`.

**Constants**

- `DERIVATION_DOMAIN` — the `"SODA-v1"` byte string.
- `ETH_SEPOLIA_CHAIN_TAG` — the chain-tag byte sequence.

See the [docs site](https://github.com/JingYuan0926/frontier/tree/main/apps/docs)
or run `pnpm docs:dev` from the repo root.

## License

MIT.
