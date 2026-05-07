// Cross-language parity vs. Rust eth_rlp.rs unit tests.

import { describe, expect, test } from "vitest";

import { decodeUnsignedLegacy, encodeUnsignedLegacy, eip155V } from "./rlp";

function unhex(s: string): Uint8Array {
  const clean = s.replace(/\s|0x/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bigintToBe(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[len - 1 - i] = Number((n >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}

describe("EIP-155 canonical vector", () => {
  test("RLP unsigned matches the spec", () => {
    const to = new Uint8Array(20).fill(0x35);
    const valueWeiBe = bigintToBe(1_000_000_000_000_000_000n, 16);
    const rlp = encodeUnsignedLegacy({
      nonce: 9n,
      gasPriceWei: 20_000_000_000n,
      gasLimit: 21_000n,
      to,
      valueWeiBe,
      data: new Uint8Array(0),
      chainId: 1n,
    });
    const expected = unhex(
      "ec098504a817c800825208943535353535353535353535353535353535353535\
       880de0b6b3a764000080018080",
    );
    expect(rlp).toEqual(expected);
  });
});

describe("eip155V", () => {
  test("recoveryId 0 on Sepolia → 22310257", () => {
    expect(eip155V(0, 11_155_111n)).toBe(22_310_257n);
  });
  test("recoveryId 1 on Sepolia → 22310258", () => {
    expect(eip155V(1, 11_155_111n)).toBe(22_310_258n);
  });
  test("recoveryId 0 on mainnet → 37", () => {
    expect(eip155V(0, 1n)).toBe(37n);
  });
});

describe("decodeUnsignedLegacy round-trip", () => {
  test("EIP-155 canonical vector decodes to the same fields", () => {
    const to = new Uint8Array(20).fill(0x35);
    const valueWeiBe = bigintToBe(1_000_000_000_000_000_000n, 16);
    const original = {
      nonce: 9n,
      gasPriceWei: 20_000_000_000n,
      gasLimit: 21_000n,
      to,
      valueWeiBe,
      data: new Uint8Array(0),
      chainId: 1n,
    };
    const rlp = encodeUnsignedLegacy(original);
    const decoded = decodeUnsignedLegacy(rlp);
    expect(decoded.nonce).toBe(original.nonce);
    expect(decoded.gasPriceWei).toBe(original.gasPriceWei);
    expect(decoded.gasLimit).toBe(original.gasLimit);
    expect(decoded.to).toEqual(original.to);
    expect(decoded.valueWeiBe).toEqual(original.valueWeiBe);
    expect(decoded.data).toEqual(original.data);
    expect(decoded.chainId).toBe(original.chainId);
  });

  test("encode → decode → encode is byte-identical", () => {
    const to = new Uint8Array(20).fill(0xaa);
    const valueWeiBe = bigintToBe(100_000_000_000_000n, 16);
    const tx = {
      nonce: 42n,
      gasPriceWei: 1_500_000_000n,
      gasLimit: 21_000n,
      to,
      valueWeiBe,
      data: new Uint8Array(0),
      chainId: 11_155_111n,
    };
    const rlp1 = encodeUnsignedLegacy(tx);
    const decoded = decodeUnsignedLegacy(rlp1);
    const rlp2 = encodeUnsignedLegacy(decoded);
    expect(rlp1).toEqual(rlp2);
  });

  test("Sepolia chainId is preserved through the round-trip", () => {
    const tx = {
      nonce: 0n,
      gasPriceWei: 1_000_000_000n,
      gasLimit: 21_000n,
      to: new Uint8Array(20).fill(0x01),
      valueWeiBe: bigintToBe(0n, 16),
      data: new Uint8Array(0),
      chainId: 11_155_111n,
    };
    const decoded = decodeUnsignedLegacy(encodeUnsignedLegacy(tx));
    expect(decoded.chainId).toBe(11_155_111n);
  });
});
