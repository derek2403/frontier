import { describe, expect, it } from "vitest";

import {
  AAVE_BORROW_AMOUNT_USDC,
  AAVE_V3_BASE_SEPOLIA,
  addressToBytes,
  borrowCalldata,
  decodeReserveRates,
  decodeUserAccountData,
  depositEthCalldata,
  getReserveDataCalldata,
  getUserAccountDataCalldata,
  rayRateToApy,
} from "./aave";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const DERIVED = addressToBytes("0xd55282657a707792c1be66a511f81d7d45ff1ce5");

describe("Aave calldata", () => {
  it("depositETH(pool, onBehalfOf, 0) matches the hand-built encoding", () => {
    const d = depositEthCalldata(AAVE_V3_BASE_SEPOLIA, DERIVED);
    expect(hex(d)).toBe(
      "474cf53d" +
        "0000000000000000000000008bab6d1b75f19e9ed9fce8b9bd338844ff79ae27" +
        "000000000000000000000000d55282657a707792c1be66a511f81d7d45ff1ce5" +
        "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("borrow(asset, amount, 2, 0, onBehalfOf) matches the encoding eth_estimateGas accepted on Base Sepolia", () => {
    // This exact calldata, sent from DERIVED to the Base Sepolia Pool, was
    // simulated with eth_estimateGas on 2026-09-09 and used 288,022 gas.
    const d = borrowCalldata(AAVE_V3_BASE_SEPOLIA, AAVE_BORROW_AMOUNT_USDC, DERIVED);
    expect(hex(d)).toBe(
      "a415bcad" +
        "000000000000000000000000ba50cd2a20f6da35d788639e581bca8d0b5d4d5f" +
        "00000000000000000000000000000000000000000000000000000000000186a0" +
        "0000000000000000000000000000000000000000000000000000000000000002" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "000000000000000000000000d55282657a707792c1be66a511f81d7d45ff1ce5",
    );
    expect(d.length).toBe(4 + 32 * 5);
  });

  it("rejects a non-positive borrow amount", () => {
    expect(() => borrowCalldata(AAVE_V3_BASE_SEPOLIA, 0n, DERIVED)).toThrow();
  });

  it("view selectors", () => {
    expect(hex(getUserAccountDataCalldata(DERIVED)).slice(0, 8)).toBe("bf92857c");
    expect(
      hex(getReserveDataCalldata(AAVE_V3_BASE_SEPOLIA.WETH_UNDERLYING)).slice(0, 8),
    ).toBe("35ea6a75");
  });
});

describe("Aave decoders", () => {
  it("getUserAccountData: six words in order", () => {
    const w = (n: bigint) => n.toString(16).padStart(64, "0");
    const ret =
      "0x" + w(74_937_476n) + w(0n) + w(62_572_792n) + w(8_600n) + w(8_350n) + w((1n << 256n) - 1n);
    const d = decodeUserAccountData(ret);
    expect(d.totalCollateralBase).toBe(74_937_476n);
    expect(d.totalDebtBase).toBe(0n);
    expect(d.availableBorrowsBase).toBe(62_572_792n);
    expect(d.currentLiquidationThreshold).toBe(8_600n);
    expect(d.ltv).toBe(8_350n);
    expect(d.healthFactor).toBe((1n << 256n) - 1n);
  });

  it("getReserveData: rates sit at words 2 and 4", () => {
    const w = (n: bigint) => n.toString(16).padStart(64, "0");
    const words = Array.from({ length: 15 }, (_, i) => w(BigInt(i)));
    words[2] = w(158_659_000_000_000_000_000_000_000n); // 15.8659% ray
    words[4] = w(29_500_000_000_000_000_000_000_000n); // 2.95% ray
    const r = decodeReserveRates("0x" + words.join(""));
    expect(r.currentLiquidityRate).toBe(158_659_000_000_000_000_000_000_000n);
    expect(r.currentVariableBorrowRate).toBe(29_500_000_000_000_000_000_000_000n);
    // 15.8659% APR compounded per second → ~17.19% APY
    expect(rayRateToApy(r.currentLiquidityRate)).toBeCloseTo(0.1719, 3);
  });
});
