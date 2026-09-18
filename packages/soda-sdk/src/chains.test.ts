import { describe, expect, it } from "vitest";

import { CHAINS, EVM_CHAIN_TAG, getChain } from "./chains";
import { SUI_CHAINS } from "./sui";
import { computeTweak, deriveForeignPk, ethAddressFromPk } from "./derive";

// A tag is an input to the derivation, so changing one changes every address
// derived under it. These tests exist to make that change deliberate: if you
// break one, you are moving people's funds to a new address.
describe("chain tags", () => {
  it("gives every EVM chain the same tag, so a wallet has one EVM address", () => {
    const tags = Object.values(CHAINS).map((c) => c.chainTag);
    for (const tag of tags) {
      expect(tag).toEqual(EVM_CHAIN_TAG);
    }
  });

  it("derives the same address on every EVM chain", () => {
    // G, as a stand-in committee key. Any valid point works here.
    const groupPk = Uint8Array.from(
      Buffer.from(
        "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
        "hex",
      ),
    );
    const owner = new Uint8Array(32).fill(7);
    const path = new Uint8Array(0);

    const addressOn = (key: keyof typeof CHAINS) => {
      const tweak = computeTweak(owner, path, getChain(key).chainTag);
      return ethAddressFromPk(deriveForeignPk(groupPk, tweak));
    };

    expect(addressOn("sepolia")).toEqual(addressOn("base-sepolia"));
  });

  it("keeps chain families apart", () => {
    // EVM and Sui share a curve but not an address format or an envelope, so
    // they keep separate tags.
    for (const sui of Object.values(SUI_CHAINS)) {
      expect(sui.chainTag).not.toEqual(EVM_CHAIN_TAG);
    }
  });

  it("uses a 32-byte zero-padded ASCII tag", () => {
    expect(EVM_CHAIN_TAG.length).toBe(32);
    expect(Buffer.from(EVM_CHAIN_TAG).toString("utf8").replace(/\0+$/, "")).toBe(
      "evm",
    );
  });
});
