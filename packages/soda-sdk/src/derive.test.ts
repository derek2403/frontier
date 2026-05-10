// Cross-language parity vs. Rust derivation.rs unit tests.

import { describe, expect, test } from "vitest";

import {
  computeTweak,
  deriveForeignPk,
  ETH_SEPOLIA_CHAIN_TAG,
  ethAddressFromPk,
} from "./derive";

function unhex(s: string): Uint8Array {
  const clean = s.replace(/\s|0x/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const G_COMPRESSED = unhex(
  "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
);
const TWO_G_UNCOMPRESSED = unhex(
  "04C6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5\
   1AE168FEA63DC339A3C58419466CEAEEF7F632653266D0E1236431A950CFE52A",
);

describe("compute_tweak parity", () => {
  test("deterministic", () => {
    const prog = new Uint8Array(32).fill(1);
    const seeds = new TextEncoder().encode("vault");
    expect(computeTweak(prog, seeds, ETH_SEPOLIA_CHAIN_TAG)).toEqual(
      computeTweak(prog, seeds, ETH_SEPOLIA_CHAIN_TAG),
    );
  });

  test("changes with seeds", () => {
    const prog = new Uint8Array(32).fill(1);
    expect(
      computeTweak(prog, new TextEncoder().encode("a"), ETH_SEPOLIA_CHAIN_TAG),
    ).not.toEqual(
      computeTweak(prog, new TextEncoder().encode("b"), ETH_SEPOLIA_CHAIN_TAG),
    );
  });

  test("changes with program", () => {
    const seeds = new TextEncoder().encode("x");
    expect(
      computeTweak(new Uint8Array(32).fill(1), seeds, ETH_SEPOLIA_CHAIN_TAG),
    ).not.toEqual(
      computeTweak(new Uint8Array(32).fill(2), seeds, ETH_SEPOLIA_CHAIN_TAG),
    );
  });
});

describe("derive_foreign_pk parity", () => {
  test("G + 1·G == 2G", () => {
    const tweak = new Uint8Array(32);
    tweak[31] = 1;
    const foreign = deriveForeignPk(G_COMPRESSED, tweak);
    expect(foreign).toEqual(TWO_G_UNCOMPRESSED);
  });

  test("zero tweak returns group_pk uncompressed", () => {
    const foreign = deriveForeignPk(G_COMPRESSED, new Uint8Array(32));
    expect(foreign.slice(1, 33)).toEqual(G_COMPRESSED.slice(1));
  });
});

describe("eth_address_from_pk", () => {
  test("deterministic and 20 bytes", () => {
    const a1 = ethAddressFromPk(TWO_G_UNCOMPRESSED);
    const a2 = ethAddressFromPk(TWO_G_UNCOMPRESSED);
    expect(a1).toEqual(a2);
    expect(a1.length).toBe(20);
    expect(a1.every((b) => b === 0)).toBe(false);
  });
});
