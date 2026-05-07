// SODA derivation — TS port of contracts/programs/soda/src/derivation.rs.
// Must match byte-for-byte. Vectors live in derive.test.ts.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";

export const DERIVATION_DOMAIN = new TextEncoder().encode("SODA-v1");

export const ETH_SEPOLIA_CHAIN_TAG: Uint8Array = (() => {
  const tag = new Uint8Array(32);
  tag.set(new TextEncoder().encode("ethereum-sepolia"), 0);
  return tag;
})();

export function computeTweak(
  requesterProgram: Uint8Array,
  seeds: Uint8Array,
  chainTag: Uint8Array,
): Uint8Array {
  const h = sha256.create();
  h.update(DERIVATION_DOMAIN);
  h.update(requesterProgram);
  h.update(seeds);
  h.update(chainTag);
  return h.digest();
}

export function deriveForeignPk(
  groupPkCompressed: Uint8Array,
  tweak: Uint8Array,
): Uint8Array {
  const groupPoint = secp256k1.ProjectivePoint.fromHex(groupPkCompressed);
  const tweakBig = bytesToBigInt(tweak);
  if (tweakBig >= secp256k1.CURVE.n) {
    throw new Error("tweak >= curve order n");
  }
  const tweaked =
    tweakBig === 0n
      ? groupPoint
      : groupPoint.add(secp256k1.ProjectivePoint.BASE.multiply(tweakBig));
  return tweaked.toRawBytes(false);
}

export function ethAddressFromPk(uncompressedPk: Uint8Array): Uint8Array {
  return keccak_256(uncompressedPk.subarray(1)).subarray(12);
}

export function deriveEthAddress(
  groupPkCompressed: Uint8Array,
  requesterProgram: Uint8Array,
  seeds: Uint8Array,
  chainTag: Uint8Array,
): { tweak: Uint8Array; foreignPk: Uint8Array; ethAddress: Uint8Array } {
  const tweak = computeTweak(requesterProgram, seeds, chainTag);
  const foreignPk = deriveForeignPk(groupPkCompressed, tweak);
  const ethAddress = ethAddressFromPk(foreignPk);
  return { tweak, foreignPk, ethAddress };
}

export function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}

export function bigintToBe(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[len - 1 - i] = Number((n >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}
