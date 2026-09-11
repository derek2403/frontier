# @soda-sdk/core

TypeScript SDK for [SODA](https://github.com/JingYuan0926/frontier): chain
signatures for Solana. Derive foreign-chain addresses from a Solana PDA,
build the payloads to sign, and broadcast the result. Ethereum / EVM and
Sui today; the same key, two encoders.

## Install

```bash
pnpm add @soda-sdk/core
# or
npm install @soda-sdk/core
# or
yarn add @soda-sdk/core
```

Bundles `@noble/curves` and `@noble/hashes` as direct deps. ESM only. The
Sui module needs nothing else; `@mysten/sui` is a devDependency used only by
the parity tests.

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

// 1. Derive the ETH address controlled by a Solana account (wallet or PDA).
const { ethAddress, foreignPk } = deriveEthAddress(
  groupPkCompressed,    // 33-byte compressed committee pubkey
  owner,                // 32-byte Solana pubkey that signs the request
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

## Sui quick example

Sui accepts secp256k1 natively (scheme flag `0x01`), so the committee and
`finalize_signature` are unchanged; only the envelope differs. The `sui_demo`
program builds the same bytes on-chain and derives the sender itself.

```ts
import {
  deriveSuiAddress,
  bytesToHex0x,
  SUI_CHAINS,
  SuiGraphQl,
  suiGraphqlUrl,
  encodeSuiTransferKind,
  encodeSuiTransactionData,
  suiSigningPayload,
  suiTransactionDigest,
  encodeSuiSignature,
  compressPk,
  SUI_DEMO_AMOUNT_MIST,
  SUI_TRANSFER_GAS_BUDGET_MIST,
  SUI_MAX_GAS_COINS,
} from '@soda-sdk/core'

const CHAIN = SUI_CHAINS['sui-testnet']
const sui = new SuiGraphQl(suiGraphqlUrl(CHAIN)) // https://graphql.testnet.sui.io/graphql

// 1. Derive: address = blake2b256(0x01 || compressed(group_pk + tweak·G)).
const { foreignPk, suiAddress } = deriveSuiAddress(groupPkCompressed, owner, seeds, CHAIN.chainTag)
const addr = bytesToHex0x(suiAddress)

// 2. Build: the sender's own SUI coins pay gas (no nonce; object versions instead).
const coins = (await sui.getGasCoins(addr)).slice(0, SUI_MAX_GAS_COINS)
const txBytes = encodeSuiTransactionData({
  kindBytes: encodeSuiTransferKind(suiAddress, SUI_DEMO_AMOUNT_MIST), // or @mysten/sui build({ onlyTransactionKind: true })
  sender: suiAddress,
  gasPayment: coins.map((c) => c.ref),
  gasPrice: await sui.getReferenceGasPrice(),
  gasBudget: SUI_TRANSFER_GAS_BUDGET_MIST,
})
const payload = suiSigningPayload(txBytes)   // sha256(blake2b256(intent || tx)): what soda stores
const digest = suiTransactionDigest(txBytes) // what Suiscan shows

// 3. sui_demo::sign_sui_transfer on Solana commits `payload`; await SigCompleted.

// 4. Attach `0x01 || r || s || pk` and execute.
const sig = encodeSuiSignature(signature, compressPk(foreignPk))
const { status, error } = await sui.executeTransaction(txBytes, [sig])
console.log(status, error, CHAIN.explorerTx(digest))
```

## What's exported

**Derivation**

- `computeTweak(owner, seeds, chainTag): Uint8Array` — 32-byte tweak.
- `deriveForeignPk(groupPkCompressed, tweak): Uint8Array` — 65-byte uncompressed.
- `ethAddressFromPk(uncompressedPk): Uint8Array` — 20-byte ETH address.
- `deriveEthAddress(groupPkCompressed, owner, seeds, chainTag)` —
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

**Chain registry**

- `CHAINS`, `getChain(key)`, `chainById(chainId)`, `chainRpcUrl(chain)` —
  EVM chains (`sepolia`, `base-sepolia`) with tags, RPCs, explorers, Aave.
- `chainFamily(key): "evm" | "sui"` — which encoder a `DEMO_CHAIN` key needs.

**Sui**

- Registry: `SUI_CHAINS`, `getSuiChain(key)`, `suiGraphqlUrl(chain)`,
  `type SuiChain`, `type SuiChainKey`.
- Address: `compressPk(pk)`, `suiAddressFromPk(pk)` (`blake2b256(0x01 || pk)`),
  `deriveSuiAddress(groupPkCompressed, owner, seeds, chainTag)` →
  `{ tweak, foreignPk, suiAddress }`, `parseSuiAddress(hex)`, `bytesToHex0x(b)`.
- BCS: `encodeSuiTransferKind(recipient, amountMist)`,
  `encodeSuiTransactionData(env: SuiTxEnvelope)`, `type SuiObjectRef`,
  `type SuiTxEnvelope`. Byte-identical to `@mysten/sui`'s `Transaction.build()`.
- Hashing / signatures: `suiIntentMessage`, `suiIntentDigest`,
  `suiSigningPayload` (the 32 bytes soda signs), `suiTransactionDigest`
  (base58, what explorers show), `encodeSuiSignature(sig64, pk)`,
  `decodeSuiSignature(bytes)`, `signSuiTransactionWithSecp256k1(txBytes, sk)`.
- Local keys (sponsors, never the committee): `parseSuiPrivateKey(input)`
  (a `suiprivkey1…` export of either scheme, or 32-byte hex as secp256k1)
  → `type SuiSigningKey`, `suiPublicKeyFromKey`, `suiAddressFromKey`,
  `suiAddressFromEd25519Pk`, `signSuiTransactionWithKey(txBytes, key)`,
  `bech32Decode`.
- GraphQL: `class SuiGraphQl` with `getChainIdentifier`, `getReferenceGasPrice`,
  `getBalance`, `getGasCoins`, `simulate`, `executeTransaction`,
  `getTransaction`, generic `query<T>`; `requestSuiFromFaucet(url, addr)`;
  types `SuiCoin`, `SuiExecuteResult`, `SuiTransactionInfo`.
- Encodings: `toBase58` / `fromBase58`, `toBase64` / `fromBase64`.
- Constants: `SUI_SECP256K1_FLAG`, `SUI_ED25519_FLAG`, `SUI_PRIVATE_KEY_HRP`,
  `SUI_INTENT_TRANSACTION_DATA`,
  `SUI_TX_DIGEST_PREFIX`, `SUI_KIND_PROGRAMMABLE`, `SUI_COIN_TYPE`,
  `SUI_COIN_OBJECT_TYPE`, `MIST_PER_SUI`, `SUI_DEMO_AMOUNT_MIST` (0.001 SUI),
  `SUI_TRANSFER_GAS_BUDGET_MIST` (0.01 SUI), `SUI_MIN_BALANCE_MIST` (0.02 SUI),
  `SUI_SPONSOR_MAX_TOPUP_MIST`, `SUI_MAX_GAS_COINS` (4).

**Helpers**

- `bigintToBe(n, len)`, `bytesToBigInt(b)`.

**Constants**

- `DERIVATION_DOMAIN` — the `"SODA-v1"` byte string.
- `ETH_SEPOLIA_CHAIN_TAG` — the chain-tag byte sequence.

See the [docs site](https://github.com/JingYuan0926/frontier/tree/main/apps/docs)
or run `pnpm docs:dev` from the repo root.

## License

MIT.
