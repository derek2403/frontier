// Parity vs. @mysten/deepbook-v3 and @mysten/sui (devDependencies only).
//
// The hand-rolled PTB encoder has to produce exactly what the official SDK
// produces, or the transaction the Solana program commits to is not the one
// DeepBook would execute. These tests are the reason the encoder can be
// trusted without shipping the SDK at runtime.

import { describe, expect, test } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { DeepBookClient } from "@mysten/deepbook-v3";
import { toBase58 as mystenToBase58 } from "@mysten/sui/utils";

import {
  applySlippage,
  decodeDeepbookQuote,
  deepbookBuyBaseKind,
  deepbookPool,
  deepbookPrice,
  deepbookQuoteKind,
  deepbookSellBaseKind,
  DEEPBOOK_TESTNET_DEEP,
  DEEPBOOK_TESTNET_DEEP_SUI,
  DEEPBOOK_TESTNET_PACKAGE_ID,
  DEEPBOOK_TESTNET_SUI,
  formatCoin,
  quoteRejection,
} from "./deepbook";
import { fromBase58, parseSuiAddress } from "./sui";
import { parseHex32, parseMoveStructTag, encodeTypeTag, uleb128 } from "./sui-ptb";

const POOL = DEEPBOOK_TESTNET_DEEP_SUI;
const TRADER = "0x7b117f9d1a245c001a4b8c8979b4bf4857fb97d96c0daf3ba3a24bd71131eaee";
const TRADER_BYTES = parseSuiAddress(TRADER);

async function buildKind(tx: Transaction): Promise<Uint8Array> {
  return tx.build({ onlyTransactionKind: true });
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * The exact bytes `@mysten/deepbook-v3` v2.3.0 produced for
 * `swapExactQuoteForBase({ poolKey: "DEEP_SUI", amount: 0.5, deepAmount: 0,
 * minOut: 0 })` followed by `transferObjects([base, quote, deep], trader)`,
 * built against Sui testnet on 2026-09-10.
 *
 * Recorded rather than rebuilt in-test because the official builder resolves
 * its coin inputs through a live client. The structural tests below rebuild
 * the same block with `@mysten/sui` alone, so the encoder is checked against
 * an independent implementation as well as against this recording.
 */
const DEEPBOOK_SDK_BUY_KIND =
  "0005010148c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f1d9248170000000001000800" +
  "000000000000000101000000000000000000000000000000000000000000000000000000000000000601000000000000" +
  "000000207b117f9d1a245c001a4b8c8979b4bf4857fb97d96c0daf3ba3a24bd71131eaee00080065cd1d000000000402" +
  "000101040000000000000000000000000000000000000000000000000000000000000000000204636f696e047a65726f" +
  "010736dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a804646565700444454550000000d8" +
  "74d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb2404706f6f6c19737761705f65786163745f" +
  "71756f74655f666f725f62617365020736dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8" +
  "046465657004444545500007000000000000000000000000000000000000000000000000000000000000000203737569" +
  "03535549000501000003000000000201000101000102000103030200000003020001000302000200010300";

/** The same block, rebuilt with @mysten/sui's own encoder and no DeepBook SDK. */
function mystenBuyKind(quoteAmount: bigint, minBaseOut: bigint): Transaction {
  const tx = new Transaction();
  tx.setSender(TRADER);
  const pool = tx.sharedObjectRef({
    objectId: POOL.poolId,
    initialSharedVersion: Number(POOL.initialSharedVersion),
    mutable: true,
  });
  const minOut = tx.pure.u64(minBaseOut);
  const clock = tx.sharedObjectRef({ objectId: "0x6", initialSharedVersion: 1, mutable: false });
  const recipient = tx.pure.address(TRADER);
  const amount = tx.pure.u64(quoteAmount);
  const [quoteCoin] = tx.splitCoins(tx.gas, [amount]);
  const deepCoin = tx.moveCall({
    target: "0x2::coin::zero",
    typeArguments: [POOL.base.type],
    arguments: [],
  });
  const swapped = tx.moveCall({
    target: `${POOL.packageId}::pool::swap_exact_quote_for_base`,
    typeArguments: [POOL.base.type, POOL.quote.type],
    arguments: [pool, quoteCoin, deepCoin, minOut, clock],
  });
  tx.transferObjects([swapped[0], swapped[1], swapped[2]], recipient);
  return tx;
}

describe("DeepBook constants", () => {
  test("the demo pool is the whitelisted DEEP/SUI market", () => {
    expect(POOL.packageId).toBe(DEEPBOOK_TESTNET_PACKAGE_ID);
    expect(POOL.base).toBe(DEEPBOOK_TESTNET_DEEP);
    expect(POOL.quote).toBe(DEEPBOOK_TESTNET_SUI);
    expect(POOL.whitelisted).toBe(true);
    expect(deepbookPool("sui-testnet")).toBe(POOL);
    expect(() => deepbookPool("sui-devnet")).toThrow();
  });

  test("ids and coin types match @mysten/deepbook-v3's own testnet constants", async () => {
    const { testnetPackageIds, testnetPools, testnetCoins } = await import("@mysten/deepbook-v3");
    expect(POOL.packageId).toBe(testnetPackageIds.DEEPBOOK_PACKAGE_ID);
    expect(POOL.poolId).toBe(testnetPools.DEEP_SUI.address);
    expect(POOL.base.type).toBe(testnetCoins.DEEP.type);
    expect(POOL.quote.type).toBe(testnetCoins.SUI.type);
    expect(Number(POOL.base.scalar)).toBe(testnetCoins.DEEP.scalar);
    expect(Number(POOL.quote.scalar)).toBe(testnetCoins.SUI.scalar);
  });
});

describe("PTB encoding vs @mysten/deepbook-v3", () => {
  test("buy matches the bytes @mysten/deepbook-v3 produced on testnet", () => {
    const mine = deepbookBuyBaseKind({
      pool: POOL,
      quoteAmount: 500_000_000n,
      minBaseOut: 0n,
      recipient: TRADER_BYTES,
    });
    expect(hex(mine)).toBe(DEEPBOOK_SDK_BUY_KIND.replace(/\s/g, ""));
  });

  test("buy matches @mysten/sui's own encoder", async () => {
    const theirs = await buildKind(mystenBuyKind(500_000_000n, 0n));
    const mine = deepbookBuyBaseKind({
      pool: POOL,
      quoteAmount: 500_000_000n,
      minBaseOut: 0n,
      recipient: TRADER_BYTES,
    });
    expect(hex(mine)).toBe(hex(theirs));
  });

  test("buy encodes minOut and amount where the pool reads them", async () => {
    const theirs = await buildKind(mystenBuyKind(1_250_000_000n, 40_000_000n));
    const mine = deepbookBuyBaseKind({
      pool: POOL,
      quoteAmount: 1_250_000_000n,
      minBaseOut: 40_000_000n, // 40 DEEP at 1e6
      recipient: TRADER_BYTES,
    });
    expect(hex(mine)).toBe(hex(theirs));
    // A different size must produce different bytes, or the amount is not
    // actually reaching the pool.
    expect(hex(mine)).not.toBe(hex(deepbookBuyBaseKind({
      pool: POOL, quoteAmount: 1_250_000_001n, minBaseOut: 40_000_000n, recipient: TRADER_BYTES,
    })));
  });

  test("sell (swap_exact_base_for_quote) matches @mysten/sui's encoder", async () => {
    const coinId = "0x" + "ab".repeat(32);
    const coinDigest = new Uint8Array(32).fill(0xcd);

    const tx = new Transaction();
    tx.setSender(TRADER);
    const pool = tx.sharedObjectRef({
      objectId: POOL.poolId,
      initialSharedVersion: Number(POOL.initialSharedVersion),
      mutable: true,
    });
    const minOut = tx.pure.u64(0n);
    const clock = tx.sharedObjectRef({ objectId: "0x6", initialSharedVersion: 1, mutable: false });
    const recipient = tx.pure.address(TRADER);
    const baseCoin = tx.objectRef({ objectId: coinId, version: 7, digest: mystenToBase58(coinDigest) });
    const deepCoin = tx.moveCall({ target: "0x2::coin::zero", typeArguments: [POOL.base.type], arguments: [] });
    const swapped = tx.moveCall({
      target: `${POOL.packageId}::pool::swap_exact_base_for_quote`,
      typeArguments: [POOL.base.type, POOL.quote.type],
      arguments: [pool, baseCoin, deepCoin, minOut, clock],
    });
    tx.transferObjects([swapped[0], swapped[1], swapped[2]], recipient);
    const theirs = await buildKind(tx);

    const mine = deepbookSellBaseKind({
      pool: POOL,
      baseCoins: [{ objectId: parseSuiAddress(coinId), version: 7n, digest: coinDigest }],
      minQuoteOut: 0n,
      recipient: TRADER_BYTES,
    });
    expect(hex(mine)).toBe(hex(theirs));
  });

  test("sell merges extra coins before swapping", () => {
    const refs = [1, 2, 3].map((i) => ({
      objectId: parseSuiAddress("0x" + i.toString(16).padStart(2, "0").repeat(32)),
      version: BigInt(i),
      digest: new Uint8Array(32).fill(i),
    }));
    const one = deepbookSellBaseKind({ pool: POOL, baseCoins: [refs[0]], minQuoteOut: 0n, recipient: TRADER_BYTES });
    const three = deepbookSellBaseKind({ pool: POOL, baseCoins: refs, minQuoteOut: 0n, recipient: TRADER_BYTES });
    // Two more owned inputs (75 bytes each) and one MergeCoins command.
    expect(three.length).toBeGreaterThan(one.length);
    expect(three[0]).toBe(0x00);
    // 4 fixed inputs + 3 coins
    expect(three[1]).toBe(7);
    expect(one[1]).toBe(5);
    expect(() => deepbookSellBaseKind({ pool: POOL, baseCoins: [], minQuoteOut: 0n, recipient: TRADER_BYTES })).toThrow();
  });

  test("quote block matches an equivalent @mysten/sui block", async () => {
    const tx = new Transaction();
    tx.setSender(TRADER);
    const pool = tx.sharedObjectRef({
      objectId: POOL.poolId,
      initialSharedVersion: Number(POOL.initialSharedVersion),
      mutable: false,
    });
    const amount = tx.pure.u64(500_000_000n);
    const clock = tx.sharedObjectRef({ objectId: "0x6", initialSharedVersion: 1, mutable: false });
    const typeArguments = [POOL.base.type, POOL.quote.type];
    tx.moveCall({ target: `${POOL.packageId}::pool::mid_price`, typeArguments, arguments: [pool, clock] });
    tx.moveCall({
      target: `${POOL.packageId}::pool::get_base_quantity_out`,
      typeArguments,
      arguments: [pool, amount, clock],
    });
    tx.moveCall({ target: `${POOL.packageId}::pool::whitelisted`, typeArguments, arguments: [pool] });
    const theirs = await buildKind(tx);

    const mine = deepbookQuoteKind({ pool: POOL, direction: "buy", amount: 500_000_000n });
    expect(Buffer.from(mine).toString("hex")).toBe(Buffer.from(theirs).toString("hex"));
  });

  test("a sell quote asks for quote-out instead of base-out", () => {
    const buy = deepbookQuoteKind({ pool: POOL, direction: "buy", amount: 1n });
    const sell = deepbookQuoteKind({ pool: POOL, direction: "sell", amount: 1n });
    expect(Buffer.from(buy).includes(Buffer.from("get_base_quantity_out"))).toBe(true);
    expect(Buffer.from(sell).includes(Buffer.from("get_quote_quantity_out"))).toBe(true);
  });
});

describe("quote decoding and sizing", () => {
  // Exactly what the testnet pool returned on 2026-09-10 for 0.5 SUI.
  const OUTPUTS: Array<Array<string | number | boolean | null>> = [
    ["25420000000"],
    ["19000000", "13030000", "0"],
    [true],
  ];

  test("decodes the three commands into a quote", () => {
    const q = decodeDeepbookQuote(OUTPUTS, POOL);
    expect(q.midPriceRaw).toBe(25_420_000_000n);
    expect(q.midPrice).toBeCloseTo(0.02542, 8);
    expect(q.baseOut).toBe(19_000_000n);
    expect(q.quoteOut).toBe(13_030_000n);
    expect(q.deepRequired).toBe(0n);
    expect(q.whitelisted).toBe(true);
    expect(quoteRejection(q, POOL, "buy")).toBeNull();
  });

  test("rejects a size the book cannot fill", () => {
    const empty = decodeDeepbookQuote([["25420000000"], ["0", "50000000", "0"], [true]], POOL);
    expect(quoteRejection(empty, POOL, "buy")).toMatch(/cannot fill/);
    const tiny = decodeDeepbookQuote([["25420000000"], ["5000000", "0", "0"], [true]], POOL);
    expect(quoteRejection(tiny, POOL, "buy")).toMatch(/below the pool minimum/);
  });

  test("rejects a pool that would charge DEEP fees", () => {
    const fee = decodeDeepbookQuote([["25420000000"], ["19000000", "0", "1000"], [false]], POOL);
    expect(quoteRejection(fee, POOL, "buy")).toMatch(/DEEP in fees/);
  });

  test("throws on a truncated simulation rather than guessing", () => {
    expect(() => decodeDeepbookQuote([["1"]], POOL)).toThrow(/expected 3 command outputs/);
    expect(() => decodeDeepbookQuote([["1"], ["1"], [true]], POOL)).toThrow(/missing return value/);
  });

  test("slippage floors the quote", () => {
    expect(applySlippage(19_000_000n, 100n)).toBe(18_810_000n);
    expect(applySlippage(19_000_000n, 0n)).toBe(19_000_000n);
    expect(() => applySlippage(1n, 10_000n)).toThrow();
  });

  test("price and amount formatting", () => {
    expect(deepbookPrice(25_420_000_000n, POOL)).toBeCloseTo(0.02542, 8);
    expect(formatCoin(19_000_000n, DEEPBOOK_TESTNET_DEEP)).toBe("19.000000");
    expect(formatCoin(500_000_000n, DEEPBOOK_TESTNET_SUI, 4)).toBe("0.5000");
    expect(formatCoin(0n, DEEPBOOK_TESTNET_SUI, 2)).toBe("0.00");
  });
});

describe("BCS primitives", () => {
  test("uleb128 boundaries", () => {
    expect(Array.from(uleb128(0))).toEqual([0]);
    expect(Array.from(uleb128(127))).toEqual([127]);
    expect(Array.from(uleb128(128))).toEqual([0x80, 0x01]);
    expect(Array.from(uleb128(300))).toEqual([0xac, 0x02]);
    expect(Array.from(uleb128(16384))).toEqual([0x80, 0x80, 0x01]);
    expect(() => uleb128(-1)).toThrow();
  });

  test("parseHex32 pads short ids and rejects long ones", () => {
    expect(parseHex32("0x6")[31]).toBe(6);
    expect(parseHex32("0x2")[31]).toBe(2);
    expect(() => parseHex32("0x" + "1".repeat(65))).toThrow();
  });

  test("type tags round-trip the DeepBook coin types", () => {
    const deep = parseMoveStructTag(DEEPBOOK_TESTNET_DEEP.type);
    expect(deep.module).toBe("deep");
    expect(deep.name).toBe("DEEP");
    expect(deep.typeParams).toEqual([]);
    const encoded = encodeTypeTag(deep);
    expect(encoded[0]).toBe(7);
    const generic = parseMoveStructTag("0x2::coin::Coin<0x2::sui::SUI>");
    expect(generic.typeParams).toHaveLength(1);
    expect(generic.typeParams[0].name).toBe("SUI");
    expect(() => parseMoveStructTag("not::a")).toThrow();
  });

  test("base58 digests round-trip through the object-ref helpers", () => {
    const d = new Uint8Array(32).fill(0xcd);
    expect(fromBase58(mystenToBase58(d))).toEqual(d);
  });
});
