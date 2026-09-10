// Sui — the second chain family behind the same primitive.
//
// Sui accepts secp256k1 signatures natively (flag 0x01), so nothing about the
// committee, the derivation, or `finalize_signature` changes. What changes is
// the envelope around the 32-byte payload:
//
//   address  = blake2b256(0x01 || compressed_pk)                 (not keccak)
//   tx bytes = BCS(TransactionData::V1 { kind, sender, gas, expiration })
//   digest   = blake2b256(intent(0,0,0) || tx bytes)
//   payload  = sha256(digest)          ← what secp256k1 signs; what soda stores
//   sig      = 0x01 || r || s || compressed_pk, base64             (98 bytes)
//
// Every function here is a pure encoder with a Rust twin in
// contracts/programs/sui_demo/src/, and both are tested against the official
// @mysten/sui SDK in sui.test.ts. The SDK itself is not a dependency: the
// published package stays at @noble/* only.
//
// Sui's public fullnodes no longer serve JSON-RPC (2026: "migrate to gRPC or
// GraphQL"), so the client speaks GraphQL. Same shape as EthRpc: a URL in,
// a handful of typed calls out.

import { blake2b } from "@noble/hashes/blake2b";
import { sha256 } from "@noble/hashes/sha2";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";

import { computeTweak, deriveForeignPk } from "./derive";
import {
  concatBytes,
  encodeProgrammableKind,
  GAS_COIN,
  input,
  nested,
  pureAddress,
  pureU64,
  safeEnv,
  u64Le,
  uleb128,
  type PtbCommand,
  type PtbInput,
} from "./sui-ptb";

// ---------------------------------------------------------------------------
// Chain registry
// ---------------------------------------------------------------------------

export type SuiChainKey = "sui-testnet" | "sui-devnet";

export type SuiChain = {
  key: SuiChainKey;
  family: "sui";
  name: string;
  /** 32-byte ASCII tag, zero-padded; feeds the SODA derivation tweak. */
  chainTag: Uint8Array;
  /** Mysten's public GraphQL endpoint, used when the env var below is unset. */
  defaultGraphql: string;
  /** Server-side env var that overrides defaultGraphql. */
  graphqlEnv: string;
  /**
   * Optional JSON-RPC endpoint. Mysten's public fullnodes stopped serving
   * JSON-RPC, so there is no default — but a provider URL, if configured,
   * is the only way to see SUI held in an *address balance* rather than in
   * Coin objects (see SuiJsonRpc.getCoins).
   */
  rpcEnv: string;
  /** POST { FixedAmountRequest: { recipient } } here for test SUI. */
  faucet: string;
  explorerTx: (digest: string) => string;
  explorerAddress: (addr: string) => string;
};

function tag32(s: string): Uint8Array {
  const t = new Uint8Array(32);
  t.set(new TextEncoder().encode(s), 0);
  return t;
}

export const SUI_CHAINS: Record<SuiChainKey, SuiChain> = {
  "sui-testnet": {
    key: "sui-testnet",
    family: "sui",
    name: "Sui Testnet",
    chainTag: tag32("sui-testnet"),
    defaultGraphql: "https://graphql.testnet.sui.io/graphql",
    graphqlEnv: "SUI_TESTNET_GRAPHQL_URL",
    rpcEnv: "SUI_TESTNET_RPC_URL",
    faucet: "https://faucet.testnet.sui.io/v2/gas",
    explorerTx: (d) => `https://suiscan.xyz/testnet/tx/${d}`,
    explorerAddress: (a) => `https://suiscan.xyz/testnet/account/${a}`,
  },
  "sui-devnet": {
    key: "sui-devnet",
    family: "sui",
    name: "Sui Devnet",
    chainTag: tag32("sui-devnet"),
    defaultGraphql: "https://graphql.devnet.sui.io/graphql",
    graphqlEnv: "SUI_DEVNET_GRAPHQL_URL",
    rpcEnv: "SUI_DEVNET_RPC_URL",
    faucet: "https://faucet.devnet.sui.io/v2/gas",
    explorerTx: (d) => `https://suiscan.xyz/devnet/tx/${d}`,
    explorerAddress: (a) => `https://suiscan.xyz/devnet/account/${a}`,
  },
};

/** Resolve a Sui chain from DEMO_CHAIN-style input. Unset = testnet. */
export function getSuiChain(key: string | undefined | null): SuiChain {
  const k = (key ?? "").trim().toLowerCase() || "sui-testnet";
  const chain = (SUI_CHAINS as Record<string, SuiChain>)[k];
  if (!chain) {
    throw new Error(
      `unknown Sui chain "${key}" — expected one of: ${Object.keys(SUI_CHAINS).join(", ")}`,
    );
  }
  return chain;
}

/** Server-side GraphQL URL for a chain (env override, else the public default). */
export function suiGraphqlUrl(
  chain: SuiChain,
  env: Record<string, string | undefined> = safeEnv(),
): string {
  const v = env[chain.graphqlEnv]?.trim();
  return v && v.length > 0 ? v : chain.defaultGraphql;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sui signature-scheme flag for secp256k1 (0x00 is Ed25519, 0x02 is secp256r1). */
export const SUI_SECP256K1_FLAG = 0x01;
/** Sui's default scheme; what a `sui keytool` / Sui Wallet export usually is. */
export const SUI_ED25519_FLAG = 0x00;
/** Bech32 human-readable part of an exported Sui private key. */
export const SUI_PRIVATE_KEY_HRP = "suiprivkey";
/** Intent { scope: TransactionData, version: V0, app_id: Sui }. */
export const SUI_INTENT_TRANSACTION_DATA = Uint8Array.from([0, 0, 0]);
/** Prefix hashed with the tx bytes to form the digest explorers show. */
export const SUI_TX_DIGEST_PREFIX = new TextEncoder().encode("TransactionData::");
export const SUI_COIN_TYPE = "0x2::sui::SUI";
export const SUI_COIN_OBJECT_TYPE = "0x2::coin::Coin<0x2::sui::SUI>";
export const MIST_PER_SUI = 1_000_000_000n;

/** What the demo sends: 0.001 SUI. */
export const SUI_DEMO_AMOUNT_MIST = 1_000_000n;
/** Gas budget for a split-and-transfer. Unused budget is refunded. */
export const SUI_TRANSFER_GAS_BUDGET_MIST = 10_000_000n;
/** What the derived address must hold before a transfer is attempted. */
export const SUI_MIN_BALANCE_MIST = 20_000_000n;
/**
 * Per-run cap on what a sponsor key will top an address up by.
 *
 * Large enough to fund a DeepBook trade in one call (the swap alone spends
 * 0.5 SUI), small enough that a bug costs test tokens and nothing else. The
 * EVM sponsor's cap exists for the same reason.
 */
export const SUI_SPONSOR_MAX_TOPUP_MIST = 1_000_000_000n;
/** Sui allows several gas coins; they are merged at execution. Keep ix args small. */
export const SUI_MAX_GAS_COINS = 4;

// ---------------------------------------------------------------------------
// Byte helpers (no Buffer: this runs in the browser too)
// ---------------------------------------------------------------------------

export function bytesToHex0x(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Parse a Sui address / object id. Accepts with or without 0x and left-pads
 * short forms (Sui prints `0x2` for the framework package) to 32 bytes.
 */
export function parseSuiAddress(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length === 0 || clean.length > 64) {
    throw new Error(`not a Sui address: ${hex}`);
  }
  const padded = clean.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Parse an address that a *user* supplied, requiring the full 32 bytes.
 *
 * `parseSuiAddress` left-pads, which is Sui's own rule and is what object
 * ids like `0x2` need — but it also turns a 20-byte EVM address pasted into
 * a recipient field into a perfectly valid Sui address that nobody controls.
 * Funds sent there are gone, and every check downstream passes because the
 * bytes are internally consistent. Anything a person typed goes through
 * this instead.
 */
export function parseSuiAddressStrict(hex: string, what = "address"): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    const hint =
      clean.length === 40
        ? " (that looks like a 20-byte EVM address; Sui addresses are 32 bytes)"
        : "";
    throw new Error(`${what} must be a full 32-byte Sui address, 64 hex characters: got ${hex}${hint}`);
  }
  return parseSuiAddress(clean);
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bitcoin-alphabet base58, as Sui prints digests. */
export function toBase58(b: Uint8Array): string {
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < b.length; i++) {
    let carry = b[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let s = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]];
  return s;
}

export function fromBase58(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    let carry = B58.indexOf(s[i]);
    if (carry < 0) throw new Error(`not base58: ${s}`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// bech32 (BIP-173, not bech32m) — only the decoder, for `suiprivkey1…`.
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

export function bech32Decode(str: string): { hrp: string; data: Uint8Array } {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) {
    throw new Error("bech32: mixed case");
  }
  const s = str.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) throw new Error("bech32: no separator");
  const hrp = s.slice(0, sep);
  const values: number[] = [];
  for (const c of s.slice(sep + 1)) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v < 0) throw new Error(`bech32: bad character "${c}"`);
    values.push(v);
  }
  if (bech32Polymod([...bech32HrpExpand(hrp), ...values]) !== 1) {
    throw new Error("bech32: checksum mismatch");
  }
  // 5-bit words → bytes, with the BIP-173 padding rules.
  const words = values.slice(0, -6);
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  if (bits >= 5 || acc !== 0) throw new Error("bech32: bad padding");
  return { hrp, data: Uint8Array.from(out) };
}

// ---------------------------------------------------------------------------
// Address derivation
// ---------------------------------------------------------------------------

/** 33-byte SEC1 compressed form from either a 65-byte uncompressed or 33-byte key. */
export function compressPk(pk: Uint8Array): Uint8Array {
  if (pk.length === 33) return pk;
  if (pk.length !== 65 || pk[0] !== 0x04) {
    throw new Error(`expected a 33- or 65-byte secp256k1 public key, got ${pk.length}`);
  }
  const out = new Uint8Array(33);
  out[0] = (pk[64] & 1) === 1 ? 0x03 : 0x02;
  out.set(pk.subarray(1, 33), 1);
  return out;
}

/**
 * `blake2b256(0x01 || compressed_pk)`. The flag byte is why a secp256k1 key
 * has a different Sui address from the same key used as Ed25519 material;
 * it is also why the address commits to the signature scheme.
 */
export function suiAddressFromPk(pk: Uint8Array): Uint8Array {
  const compressed = compressPk(pk);
  return blake2b(concatBytes(Uint8Array.from([SUI_SECP256K1_FLAG]), compressed), {
    dkLen: 32,
  });
}

export function deriveSuiAddress(
  groupPkCompressed: Uint8Array,
  owner: Uint8Array,
  path: Uint8Array,
  chainTag: Uint8Array,
): { tweak: Uint8Array; foreignPk: Uint8Array; suiAddress: Uint8Array } {
  const tweak = computeTweak(owner, path, chainTag);
  const foreignPk = deriveForeignPk(groupPkCompressed, tweak);
  const suiAddress = suiAddressFromPk(foreignPk);
  return { tweak, foreignPk, suiAddress };
}

/** `blake2b256(0x00 || pk)` for an ordinary Ed25519 Sui account (a sponsor, say). */
export function suiAddressFromEd25519Pk(pk: Uint8Array): Uint8Array {
  if (pk.length !== 32) throw new Error(`expected a 32-byte Ed25519 public key, got ${pk.length}`);
  return blake2b(concatBytes(Uint8Array.from([SUI_ED25519_FLAG]), pk), { dkLen: 32 });
}

// ---------------------------------------------------------------------------
// Local keys (sponsors). The committee never goes through these.
// ---------------------------------------------------------------------------

export type SuiSigningKey = {
  scheme: "ed25519" | "secp256k1";
  /** 32-byte seed (Ed25519) or scalar (secp256k1). */
  secretKey: Uint8Array;
};

/**
 * Accepts what people actually have: a `suiprivkey1…` export from
 * `sui keytool` / Sui Wallet (bech32 over `flag || 32-byte secret`, flag
 * 0x00 Ed25519 or 0x01 secp256k1), or 32 bytes of hex, taken as secp256k1
 * like the EVM sponsor key. secp256r1 exports are refused by name.
 */
export function parseSuiPrivateKey(input: string): SuiSigningKey {
  const s = input.trim();
  if (s.toLowerCase().startsWith(SUI_PRIVATE_KEY_HRP + "1")) {
    const { hrp, data } = bech32Decode(s);
    if (hrp !== SUI_PRIVATE_KEY_HRP) throw new Error(`not a Sui private key (hrp "${hrp}")`);
    if (data.length !== 33) throw new Error(`Sui private key should decode to 33 bytes, got ${data.length}`);
    const flag = data[0];
    const secretKey = data.subarray(1);
    if (flag === SUI_ED25519_FLAG) return { scheme: "ed25519", secretKey };
    if (flag === SUI_SECP256K1_FLAG) return { scheme: "secp256k1", secretKey };
    throw new Error(`unsupported Sui key scheme flag 0x${flag.toString(16)} (secp256r1 is not supported here)`);
  }
  const hex = s.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("expected a suiprivkey1… export or 32 bytes of hex");
  }
  const secretKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) secretKey[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { scheme: "secp256k1", secretKey };
}

export function suiPublicKeyFromKey(key: SuiSigningKey): Uint8Array {
  return key.scheme === "ed25519"
    ? ed25519.getPublicKey(key.secretKey)
    : secp256k1.getPublicKey(key.secretKey, true);
}

export function suiAddressFromKey(key: SuiSigningKey): Uint8Array {
  const pk = suiPublicKeyFromKey(key);
  return key.scheme === "ed25519" ? suiAddressFromEd25519Pk(pk) : suiAddressFromPk(pk);
}

/**
 * Sign a transaction with a local key of either scheme. Ed25519 signs the
 * intent digest directly; secp256k1 signs sha256 of it (Sui's rule, and the
 * same payload the committee signs). Returns the serialized
 * `flag || signature || pubkey` Sui expects.
 */
export function signSuiTransactionWithKey(
  txBytes: Uint8Array,
  key: SuiSigningKey,
): { serialized: Uint8Array; signatureB64: string } {
  let serialized: Uint8Array;
  if (key.scheme === "ed25519") {
    const sig = ed25519.sign(suiIntentDigest(txBytes), key.secretKey);
    serialized = concatBytes(Uint8Array.from([SUI_ED25519_FLAG]), sig, ed25519.getPublicKey(key.secretKey));
  } else {
    serialized = encodeSuiSignature(
      secp256k1.sign(suiSigningPayload(txBytes), key.secretKey, { lowS: true }).toCompactRawBytes(),
      secp256k1.getPublicKey(key.secretKey, true),
    );
  }
  return { serialized, signatureB64: toBase64(serialized) };
}

// ---------------------------------------------------------------------------
// BCS encoding of TransactionData
// ---------------------------------------------------------------------------

export type SuiObjectRef = {
  objectId: Uint8Array; // 32
  version: bigint;
  digest: Uint8Array; // 32, i.e. base58-decoded
};

export type SuiTxEnvelope = {
  /** BCS `TransactionKind`; from encodeSuiTransferKind or @mysten/sui's build({ onlyTransactionKind: true }). */
  kindBytes: Uint8Array;
  sender: Uint8Array; // 32
  gasPayment: SuiObjectRef[];
  /** Defaults to sender. A different owner is a sponsored transaction and needs their signature too. */
  gasOwner?: Uint8Array;
  gasPrice: bigint;
  gasBudget: bigint;
};

/** First byte of a `TransactionKind` that is a ProgrammableTransaction. */
export const SUI_KIND_PROGRAMMABLE = 0x00;

/**
 * The simplest useful PTB: split `amountMist` off the gas coin and send it.
 *
 *   inputs:   [Pure(u64 amount), Pure(address recipient)]
 *   commands: [SplitCoins(GasCoin, [Input(0)]),
 *              TransferObjects([NestedResult(0, 0)], Input(1))]
 *
 * NestedResult rather than Result because that is what @mysten/sui emits for
 * a split, and the parity test holds the two byte-for-byte.
 */
export function encodeSuiTransferKind(recipient: Uint8Array, amountMist: bigint): Uint8Array {
  if (recipient.length !== 32) throw new Error("recipient must be 32 bytes");
  const inputs: PtbInput[] = [pureU64(amountMist), pureAddress(recipient)];
  const commands: PtbCommand[] = [
    { kind: "splitCoins", coin: GAS_COIN, amounts: [input(0)] },
    { kind: "transferObjects", objects: [nested(0, 0)], address: input(1) },
  ];
  return encodeProgrammableKind(inputs, commands);
}

/**
 * BCS `TransactionData::V1 { kind, sender, gas_data, expiration: None }`.
 * The Rust twin (`sui_bcs::encode_transaction_data`) produces the same bytes
 * on-chain from the same inputs, which is how the program commits to exactly
 * this transaction.
 */
export function encodeSuiTransactionData(env: SuiTxEnvelope): Uint8Array {
  if (env.sender.length !== 32) throw new Error("sender must be 32 bytes");
  if (env.kindBytes.length === 0 || env.kindBytes[0] !== SUI_KIND_PROGRAMMABLE) {
    throw new Error("kindBytes must be a BCS ProgrammableTransaction (first byte 0x00)");
  }
  if (env.gasPayment.length === 0) throw new Error("at least one gas coin is required");
  const gasOwner = env.gasOwner ?? env.sender;
  if (gasOwner.length !== 32) throw new Error("gasOwner must be 32 bytes");

  const parts: Uint8Array[] = [
    Uint8Array.from([0]), // TransactionData::V1
    env.kindBytes,
    env.sender,
    uleb128(env.gasPayment.length),
  ];
  for (const ref of env.gasPayment) {
    if (ref.objectId.length !== 32 || ref.digest.length !== 32) {
      throw new Error("object refs need a 32-byte id and a 32-byte digest");
    }
    parts.push(ref.objectId, u64Le(ref.version), Uint8Array.from([32]), ref.digest);
  }
  parts.push(gasOwner, u64Le(env.gasPrice), u64Le(env.gasBudget), Uint8Array.from([0])); // expiration None
  return concatBytes(...parts);
}

// ---------------------------------------------------------------------------
// Hashing and signatures
// ---------------------------------------------------------------------------

export function suiIntentMessage(txBytes: Uint8Array): Uint8Array {
  return concatBytes(SUI_INTENT_TRANSACTION_DATA, txBytes);
}

/** `blake2b256(intent || tx)`: what an Ed25519 wallet would sign directly. */
export function suiIntentDigest(txBytes: Uint8Array): Uint8Array {
  return blake2b(suiIntentMessage(txBytes), { dkLen: 32 });
}

/**
 * The 32 bytes SODA signs for a Sui transaction: `sha256(blake2b256(intent || tx))`.
 * Sui's secp256k1 verifier hashes the intent digest with SHA-256 before the
 * ECDSA check, so the recoverable signature over THIS value is what the
 * network accepts and what `finalize_signature` recovers on Solana.
 */
export function suiSigningPayload(txBytes: Uint8Array): Uint8Array {
  return sha256(suiIntentDigest(txBytes));
}

/** `blake2b256("TransactionData::" || tx)`, base58: the digest explorers show. */
export function suiTransactionDigest(txBytes: Uint8Array): string {
  return toBase58(blake2b(concatBytes(SUI_TX_DIGEST_PREFIX, txBytes), { dkLen: 32 }));
}

/** `0x01 || r || s || compressed_pk` — 98 bytes; base64 it for the RPC. */
export function encodeSuiSignature(sig64: Uint8Array, pk: Uint8Array): Uint8Array {
  if (sig64.length !== 64) throw new Error("signature must be 64 bytes (r || s)");
  return concatBytes(Uint8Array.from([SUI_SECP256K1_FLAG]), sig64, compressPk(pk));
}

export function decodeSuiSignature(serialized: Uint8Array): {
  flag: number;
  signature: Uint8Array;
  publicKey: Uint8Array;
} {
  if (serialized.length !== 98 || serialized[0] !== SUI_SECP256K1_FLAG) {
    throw new Error(`not a serialized Sui secp256k1 signature (${serialized.length} bytes, flag ${serialized[0]})`);
  }
  return {
    flag: serialized[0],
    signature: serialized.subarray(1, 65),
    publicKey: serialized.subarray(65),
  };
}

/**
 * Sign a Sui transaction with a raw secp256k1 secret. Used by the sponsor
 * that tops derived addresses up with gas; the committee never calls this.
 */
export function signSuiTransactionWithSecp256k1(
  txBytes: Uint8Array,
  secretKey: Uint8Array,
): { signatureB64: string; recoveryId: number } {
  const payload = suiSigningPayload(txBytes);
  const sig = secp256k1.sign(payload, secretKey, { lowS: true });
  const pk = secp256k1.getPublicKey(secretKey, true);
  return {
    signatureB64: toBase64(encodeSuiSignature(sig.toCompactRawBytes(), pk)),
    recoveryId: sig.recovery ?? 0,
  };
}

// ---------------------------------------------------------------------------
// GraphQL client
// ---------------------------------------------------------------------------

export type SuiCoin = { ref: SuiObjectRef; balance: bigint };

export type SuiExecuteResult = {
  digest: string;
  status: "SUCCESS" | "FAILURE";
  error: string | null;
};

export type SuiTransactionInfo = {
  digest: string;
  sender: string;
  /** BCS TransactionData, exactly the bytes that were signed. */
  txBytes: Uint8Array;
  /** Serialized user signatures (flag || sig || pk). */
  signatures: Uint8Array[];
  status: "SUCCESS" | "FAILURE" | null;
  error: string | null;
  checkpoint: bigint | null;
  timestamp: string | null;
};

type GqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

/**
 * Tiny Sui GraphQL client. Mysten deprecated JSON-RPC on the public
 * fullnodes; GraphQL is the supported read/write path that needs no key.
 */
export class SuiGraphQl {
  private readonly timeoutMs: number;

  constructor(private readonly url: string, opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get endpoint(): string {
    return this.url;
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        // Without this a host that accepts the connection and never answers
        // hangs the caller until the platform's function timeout, with no
        // message naming the endpoint. The EVM side learned this from a dead
        // MPC coordinator.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      const why = err.name === "TimeoutError" ? `no response in ${this.timeoutMs}ms` : `${err.name}: ${err.message}`;
      throw new Error(`sui graphql: ${why} from ${this.url}`);
    }
    let body: GqlResponse<T>;
    try {
      body = (await resp.json()) as GqlResponse<T>;
    } catch {
      throw new Error(`sui graphql ${resp.status}: non-JSON response from ${this.url}`);
    }
    if (body.errors?.length) {
      throw new Error(`sui graphql: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    if (!body.data) throw new Error(`sui graphql ${resp.status}: empty response`);
    return body.data;
  }

  async getChainIdentifier(): Promise<string> {
    const d = await this.query<{ chainIdentifier: string }>("{ chainIdentifier }");
    return d.chainIdentifier;
  }

  async getReferenceGasPrice(): Promise<bigint> {
    const d = await this.query<{ epoch: { referenceGasPrice: string } | null }>(
      "{ epoch { referenceGasPrice } }",
    );
    if (!d.epoch) throw new Error("sui graphql: no current epoch");
    return BigInt(d.epoch.referenceGasPrice);
  }

  /**
   * Total held of one coin type, in its smallest unit. Defaults to SUI.
   * Zero for an address the network has never seen.
   */
  async getBalance(addressHex: string, coinType: string = SUI_COIN_TYPE): Promise<bigint> {
    const d = await this.query<{
      address: { balance: { totalBalance: string | null } | null } | null;
    }>(
      `query($addr: SuiAddress!, $type: String!) {
         address(address: $addr) { balance(coinType: $type) { totalBalance } }
       }`,
      { addr: addressHex, type: coinType },
    );
    const total = d.address?.balance?.totalBalance;
    return total ? BigInt(total) : 0n;
  }

  /**
   * Coin objects of one type owned by the address, largest first.
   *
   * Paginated to exhaustion rather than sorting one page: the connection is
   * ordered by object id, so a single page of an address holding many small
   * coins can miss the large one entirely and make a well-funded address
   * look unable to pay.
   */
  async getCoins(
    addressHex: string,
    coinObjectType: string = SUI_COIN_OBJECT_TYPE,
    opts: { maxPages?: number; pageSize?: number } = {},
  ): Promise<SuiCoin[]> {
    const pageSize = opts.pageSize ?? 50;
    const maxPages = opts.maxPages ?? 20;
    const out: SuiCoin[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < maxPages; page++) {
      const d: {
        address: {
          objects: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              address: string;
              version: string;
              digest: string;
              contents: { json: { balance?: string } | null } | null;
            }>;
          };
        } | null;
        // `objects` yields MoveObject nodes, so `contents` is directly available.
      } = await this.query(
        `query($addr: SuiAddress!, $first: Int!, $after: String, $type: String!) {
           address(address: $addr) {
             objects(first: $first, after: $after, filter: { type: $type }) {
               pageInfo { hasNextPage endCursor }
               nodes { address version digest contents { json } }
             }
           }
         }`,
        { addr: addressHex, first: pageSize, after: cursor, type: coinObjectType },
      );
      const conn = d.address?.objects;
      if (!conn) break;
      for (const n of conn.nodes) {
        out.push({
          ref: {
            objectId: parseSuiAddress(n.address),
            version: BigInt(n.version),
            digest: fromBase58(n.digest),
          },
          balance: BigInt(n.contents?.json?.balance ?? "0"),
        });
      }
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
      cursor = conn.pageInfo.endCursor;
    }
    return out.sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0));
  }

  /** SUI coin objects owned by the address, largest first. */
  async getGasCoins(addressHex: string): Promise<SuiCoin[]> {
    return this.getCoins(addressHex, SUI_COIN_OBJECT_TYPE);
  }

  /**
   * Simulate and return each command's Move return values, decoded from
   * GraphQL's JSON form. Read-only Move calls (a DeepBook quote, say) go
   * through here: no signature, no gas, nothing on chain.
   */
  async simulateReturnValues(
    txBytes: Uint8Array,
  ): Promise<Array<Array<string | number | boolean | null>>> {
    const d = await this.query<{
      simulateTransaction: {
        outputs: Array<{ returnValues: Array<{ value: { json: string | number | boolean | null } | null }> | null }> | null;
        effects: { status: "SUCCESS" | "FAILURE"; executionError: { message: string | null } | null } | null;
      } | null;
    }>(
      `query($tx: JSON!) {
         simulateTransaction(transaction: $tx, checksEnabled: false, doGasSelection: false) {
           outputs { returnValues { value { json } } }
           effects { status executionError { message } }
         }
       }`,
      { tx: { bcs: { value: toBase64(txBytes) } } },
    );
    const sim = d.simulateTransaction;
    if (!sim) throw new Error("sui graphql: simulateTransaction returned nothing");
    if (sim.effects?.status === "FAILURE") {
      throw new Error(`sui simulation failed: ${sim.effects.executionError?.message ?? "unknown"}`);
    }
    return (sim.outputs ?? []).map((o) => (o.returnValues ?? []).map((r) => r.value?.json ?? null));
  }

  /**
   * The version at which an object became shared, which a shared-object
   * transaction input must name. Constant for the life of the object, so
   * callers normally hardcode it; this re-derives it after a redeploy.
   */
  async getSharedObjectVersion(objectIdHex: string): Promise<bigint> {
    const d = await this.query<{
      object: { owner: { initialSharedVersion?: string } | null } | null;
    }>(
      `query($id: SuiAddress!) {
         object(address: $id) { owner { ... on Shared { initialSharedVersion } } }
       }`,
      { id: objectIdHex },
    );
    const v = d.object?.owner?.initialSharedVersion;
    if (v === undefined || v === null) throw new Error(`object ${objectIdHex} is not shared`);
    return BigInt(v);
  }

  /**
   * Dry-run the exact bytes that will be signed. A transfer that would fail
   * (gas budget too low, coin already spent) is reported here, before any
   * Solana transaction is paid for.
   */
  async simulate(txBytes: Uint8Array): Promise<{ status: "SUCCESS" | "FAILURE"; error: string | null }> {
    const d = await this.query<{
      simulateTransaction: {
        effects: { status: "SUCCESS" | "FAILURE"; executionError: { message: string | null } | null } | null;
      } | null;
    }>(
      `query($tx: JSON!) {
         simulateTransaction(transaction: $tx, checksEnabled: true) {
           effects { status executionError { message } }
         }
       }`,
      { tx: { bcs: { value: toBase64(txBytes) } } },
    );
    const eff = d.simulateTransaction?.effects;
    if (!eff) throw new Error("sui graphql: simulateTransaction returned no effects");
    return { status: eff.status, error: eff.executionError?.message ?? null };
  }

  /** Submit and wait for finality. `signatures` are serialized (flag || sig || pk). */
  async executeTransaction(txBytes: Uint8Array, signatures: Uint8Array[]): Promise<SuiExecuteResult> {
    const d = await this.query<{
      executeTransaction: {
        effects: {
          digest: string;
          status: "SUCCESS" | "FAILURE";
          executionError: { message: string | null } | null;
        } | null;
      };
    }>(
      `mutation($tx: Base64!, $sigs: [Base64!]!) {
         executeTransaction(transactionDataBcs: $tx, signatures: $sigs) {
           effects { digest status executionError { message } }
         }
       }`,
      { tx: toBase64(txBytes), sigs: signatures.map(toBase64) },
    );
    const eff = d.executeTransaction.effects;
    if (!eff) throw new Error("sui graphql: executeTransaction returned no effects");
    return { digest: eff.digest, status: eff.status, error: eff.executionError?.message ?? null };
  }

  /** Look a finalized transaction up by digest; null if the node has not indexed it (yet). */
  async getTransaction(digest: string): Promise<SuiTransactionInfo | null> {
    const d = await this.query<{
      transaction: {
        digest: string;
        sender: { address: string } | null;
        transactionBcs: string | null;
        // `scheme` is a union type on this schema; the flag byte inside
        // signatureBytes says the same thing, so it is not requested.
        signatures: Array<{ signatureBytes: string }>;
        effects: {
          status: "SUCCESS" | "FAILURE";
          executionError: { message: string | null } | null;
          checkpoint: { sequenceNumber: string } | null;
          timestamp: string | null;
        } | null;
      } | null;
    }>(
      `query($digest: String!) {
         transaction(digest: $digest) {
           digest
           sender { address }
           transactionBcs
           signatures { signatureBytes }
           effects { status executionError { message } checkpoint { sequenceNumber } timestamp }
         }
       }`,
      { digest },
    );
    const t = d.transaction;
    if (!t) return null;
    return {
      digest: t.digest,
      sender: t.sender?.address ?? "",
      txBytes: t.transactionBcs ? fromBase64(t.transactionBcs) : new Uint8Array(0),
      signatures: t.signatures.map((s) => fromBase64(s.signatureBytes)),
      status: t.effects?.status ?? null,
      error: t.effects?.executionError?.message ?? null,
      checkpoint: t.effects?.checkpoint ? BigInt(t.effects.checkpoint.sequenceNumber) : null,
      timestamp: t.effects?.timestamp ?? null,
    };
  }
}

/**
 * Ask a Sui faucet for test SUI. Returns true if the faucet accepted the
 * request; the caller polls the balance. Public faucets rate-limit per IP,
 * so a 429 is the common failure and is reported, not thrown.
 */
export async function requestSuiFromFaucet(
  faucetUrl: string,
  recipientHex: string,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; status: number; body: string }> {
  let resp: Response;
  try {
    resp = await fetch(faucetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ FixedAmountRequest: { recipient: recipientHex } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // A faucet that hangs is a normal outcome, not an exception the caller
    // should have to handle: report it like any other refusal.
    return { ok: false, status: 0, body: `${faucetUrl} unreachable: ${(e as Error).message}` };
  }
  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body: body.slice(0, 300) };
}

// ---------------------------------------------------------------------------
// JSON-RPC (optional, for coins held in an address balance)
// ---------------------------------------------------------------------------

/** Provider JSON-RPC URL for a chain, or null when none is configured. */
export function suiRpcUrl(
  chain: SuiChain,
  env: Record<string, string | undefined> = safeEnv(),
): string | null {
  const v = env[chain.rpcEnv]?.trim();
  return v && v.length > 0 ? v : null;
}

/**
 * A minimal Sui JSON-RPC client, used for one thing GraphQL cannot do.
 *
 * Sui can hold SUI in an **address balance** instead of in `Coin` objects.
 * An address in that state owns no coin object at all, so GraphQL's
 * `objects` connection correctly returns nothing while the address is
 * perfectly able to pay — and a transaction from it names a gas payment
 * with **version 0**, a sentinel the network resolves against the balance.
 * `suix_getCoins` reports those refs; the GraphQL schema has no equivalent.
 *
 * This is why it exists at all: SODA's own derived addresses hold ordinary
 * coin objects and need only GraphQL, but a *sponsor* funded from a wallet
 * or a faucet usually does not. Mysten's public fullnodes no longer serve
 * JSON-RPC, so this needs a provider URL and is skipped when there is none.
 */
export class SuiJsonRpc {
  private readonly timeoutMs: number;

  constructor(private readonly url: string, opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get endpoint(): string {
    return this.url;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      const why =
        err.name === "TimeoutError" ? `no response in ${this.timeoutMs}ms` : `${err.name}: ${err.message}`;
      throw new Error(`sui rpc: ${why} from ${this.url}`);
    }
    const body = (await resp.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`sui rpc ${method}: ${body.error.message}`);
    return body.result as T;
  }

  /** Coin refs usable as gas payment, largest first. Includes address-balance refs. */
  async getCoins(addressHex: string, coinType: string = SUI_COIN_TYPE): Promise<SuiCoin[]> {
    const out: SuiCoin[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r: {
        data?: Array<{ coinObjectId: string; version: string; digest: string; balance: string }>;
        hasNextPage?: boolean;
        nextCursor?: string | null;
      } = await this.call("suix_getCoins", [addressHex, coinType, cursor, 50]);
      for (const c of r.data ?? []) {
        out.push({
          ref: {
            objectId: parseSuiAddress(c.coinObjectId),
            version: BigInt(c.version),
            digest: fromBase58(c.digest),
          },
          balance: BigInt(c.balance),
        });
      }
      if (!r.hasNextPage || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out.sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0));
  }
}

/**
 * Coin refs for an address, preferring JSON-RPC when one is configured.
 *
 * GraphQL is the default everywhere else in this SDK, but it cannot see SUI
 * held in an address balance (see SuiJsonRpc). Callers that need to *spend*
 * from an arbitrary address — the sponsor, above all — go through this so a
 * wallet-funded key is not reported as empty.
 */
export async function fetchSpendableCoins(
  addressHex: string,
  sources: { graphql: SuiGraphQl; rpc?: SuiJsonRpc | null },
  coinType: string = SUI_COIN_TYPE,
  coinObjectType: string = SUI_COIN_OBJECT_TYPE,
): Promise<SuiCoin[]> {
  if (sources.rpc) {
    const viaRpc = await sources.rpc.getCoins(addressHex, coinType);
    if (viaRpc.length > 0) return viaRpc;
  }
  return sources.graphql.getCoins(addressHex, coinObjectType);
}
