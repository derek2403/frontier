// DeepBook V3 — the Sui demo's non-trivial action, and the Sui counterpart of
// `aave.ts`.
//
// DeepBook is Sui's on-chain central limit order book. The demo trades on it
// from a SODA-derived address, so the claim is not "a Solana wallet can move
// SUI" but "a Solana wallet is a market participant on Sui": it takes
// liquidity off a real order book and ends up holding a token it never had,
// then spends that token back.
//
// Two actions, each ONE Sui transaction through the identical pipeline; only
// the programmable block differs:
//
//   buy  — swap_exact_quote_for_base: SUI in, DEEP out
//   sell — swap_exact_base_for_quote: DEEP in, SUI out
//
// Both use the DEEP/SUI pool, which is *whitelisted*: taker and maker fees
// are zero and no DEEP is required to pay fees (a `coin::zero<DEEP>` is
// passed instead). That matters for a demo — on a normal DeepBook pool the
// trader must hold DEEP to pay fees, which would mean a second funding
// problem on top of gas.
//
// Like `aave.ts`, everything chain-specific is a constant here and the
// transaction bytes are hand-encoded (via sui-ptb.ts) rather than pulled from
// `@mysten/deepbook-v3`, so the published package keeps its `@noble/*`-only
// dependency list. deepbook.test.ts holds every encoder byte-for-byte against
// the official SDK.

import {
  concatBytes,
  encodeProgrammableKind,
  GAS_COIN,
  input,
  nested,
  parseHex32,
  parseMoveStructTag,
  pureAddress,
  pureU64,
  result,
  type MoveStructTag,
  type PtbCommand,
  type PtbInput,
} from "./sui-ptb";
import type { SuiObjectRef } from "./sui";

// ---------------------------------------------------------------------------
// Deployment constants
// ---------------------------------------------------------------------------

/**
 * DeepBook V3 on Sui testnet, from `@mysten/deepbook-v3`'s own constants
 * (testnetPackageIds / testnetPools / testnetCoins, v2.3.0). Verified live on
 * 2026-09-10: the DEEP/SUI pool reports `whitelisted() == true` and
 * `pool_trade_params() == { takerFee: 0, makerFee: 0, stakeRequired: 0 }`.
 */
export const DEEPBOOK_TESTNET_PACKAGE_ID =
  "0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24";

export const SUI_CLOCK_OBJECT_ID = "0x6";
/** The clock has been shared since genesis. */
export const SUI_CLOCK_INITIAL_SHARED_VERSION = 1n;

/** DeepBook prices are fixed-point with 9 decimals. */
export const DEEPBOOK_FLOAT_SCALAR = 1_000_000_000n;

export type DeepBookCoin = {
  type: string;
  symbol: string;
  /** Smallest-unit multiplier: 1e9 for SUI, 1e6 for DEEP. */
  scalar: bigint;
  decimals: number;
};

export const DEEPBOOK_TESTNET_SUI: DeepBookCoin = {
  type: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  symbol: "SUI",
  scalar: 1_000_000_000n,
  decimals: 9,
};

export const DEEPBOOK_TESTNET_DEEP: DeepBookCoin = {
  type: "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP",
  symbol: "DEEP",
  scalar: 1_000_000n,
  decimals: 6,
};

export type DeepBookPool = {
  key: string;
  packageId: string;
  poolId: string;
  /**
   * The version at which the pool object became shared. Immutable for the
   * life of the object, so it is a constant rather than a lookup; a shared
   * object input that names the wrong one is rejected by the network, and
   * `SuiGraphQl.getSharedObjectVersion` can re-derive it if a pool is ever
   * redeployed.
   */
  initialSharedVersion: bigint;
  base: DeepBookCoin;
  quote: DeepBookCoin;
  /** True when the pool charges no fees and needs no DEEP to trade. */
  whitelisted: boolean;
  /** Smallest fillable base quantity, in base units. Below this a swap fills nothing. */
  minSizeBase: bigint;
  /** Base quantity granularity, in base units. */
  lotSizeBase: bigint;
};

/**
 * DEEP/SUI on testnet: base DEEP, quote SUI. Buying base with quote means
 * spending SUI (which the derived address already holds for gas) to receive
 * DEEP, so the demo needs no second funding step.
 */
export const DEEPBOOK_TESTNET_DEEP_SUI: DeepBookPool = {
  key: "DEEP_SUI",
  packageId: DEEPBOOK_TESTNET_PACKAGE_ID,
  poolId: "0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f",
  initialSharedVersion: 390_631_965n,
  base: DEEPBOOK_TESTNET_DEEP,
  quote: DEEPBOOK_TESTNET_SUI,
  whitelisted: true,
  minSizeBase: 10_000_000n, // 10 DEEP
  lotSizeBase: 1_000_000n, // 1 DEEP
};

export const DEEPBOOK_POOLS: Record<string, DeepBookPool> = {
  "sui-testnet": DEEPBOOK_TESTNET_DEEP_SUI,
};

/** The pool the demo trades on for a given Sui network. */
export function deepbookPool(chainKey: string): DeepBookPool {
  const pool = DEEPBOOK_POOLS[chainKey];
  if (!pool) {
    throw new Error(
      `no DeepBook pool configured for "${chainKey}" — supported: ${Object.keys(DEEPBOOK_POOLS).join(", ")}`,
    );
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Demo sizing
// ---------------------------------------------------------------------------

/** SUI spent per buy. Chosen to clear the pool's 10 DEEP minimum with room. */
export const DEEPBOOK_BUY_QUOTE_MIST = 500_000_000n; // 0.5 SUI
/** Gas budget for a swap. Unused budget is refunded. */
export const DEEPBOOK_SWAP_GAS_BUDGET_MIST = 30_000_000n; // 0.03 SUI
/** What the derived address must hold before a buy is attempted. */
export const DEEPBOOK_MIN_BALANCE_MIST = 700_000_000n; // 0.7 SUI
/** Default slippage tolerance applied to a quote to get `min_out`. */
export const DEEPBOOK_SLIPPAGE_BPS = 100n; // 1%

/** `minOut = quoted * (10000 - slippageBps) / 10000`, floored. */
export function applySlippage(quoted: bigint, slippageBps: bigint = DEEPBOOK_SLIPPAGE_BPS): bigint {
  if (slippageBps < 0n || slippageBps >= 10_000n) throw new Error(`slippageBps out of range: ${slippageBps}`);
  return (quoted * (10_000n - slippageBps)) / 10_000n;
}

/**
 * DeepBook's raw fixed-point price into quote-per-base as a JS number, for
 * display only. `raw * baseScalar / (quoteScalar * FLOAT_SCALAR)`.
 */
export function deepbookPrice(rawPrice: bigint, pool: DeepBookPool): number {
  return (
    Number((rawPrice * pool.base.scalar * 1_000_000n) / (pool.quote.scalar * DEEPBOOK_FLOAT_SCALAR)) / 1e6
  );
}

/** Format a smallest-unit amount for display, e.g. 19000000 DEEP units → "19.000000". */
export function formatCoin(units: bigint, coin: DeepBookCoin, dp = coin.decimals): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const whole = v / coin.scalar;
  const frac = v % coin.scalar;
  const fracStr = frac.toString().padStart(coin.decimals, "0").slice(0, dp);
  return `${neg ? "-" : ""}${whole}${dp > 0 ? "." + fracStr : ""}`;
}

// ---------------------------------------------------------------------------
// Transaction kinds
// ---------------------------------------------------------------------------

const SUI_FRAMEWORK_ID = parseHex32("0x2");

function poolInput(pool: DeepBookPool, mutable: boolean): PtbInput {
  return {
    kind: "shared",
    objectId: parseHex32(pool.poolId),
    initialSharedVersion: pool.initialSharedVersion,
    mutable,
  };
}

function clockInput(mutable = false): PtbInput {
  return {
    kind: "shared",
    objectId: parseHex32(SUI_CLOCK_OBJECT_ID),
    initialSharedVersion: SUI_CLOCK_INITIAL_SHARED_VERSION,
    mutable,
  };
}

function poolTypeArgs(pool: DeepBookPool): MoveStructTag[] {
  return [parseMoveStructTag(pool.base.type), parseMoveStructTag(pool.quote.type)];
}

/** `0x2::coin::zero<T>()` — the zero-value DEEP coin a whitelisted pool takes as its fee input. */
function coinZeroCommand(coinType: string): PtbCommand {
  return {
    kind: "moveCall",
    packageId: SUI_FRAMEWORK_ID,
    module: "coin",
    function: "zero",
    typeArguments: [parseMoveStructTag(coinType)],
    arguments: [],
  };
}

/**
 * Buy base with quote: `swap_exact_quote_for_base`.
 *
 * The quote coin is split off the gas coin, so the only thing the derived
 * address needs is SUI. The call returns (base, leftover quote, leftover
 * DEEP) and all three are transferred back to the trader — DeepBook hands
 * back whatever it could not fill, so nothing is stranded in the block.
 *
 * Byte-identical to `@mysten/deepbook-v3`'s
 * `swapExactQuoteForBase` + `transferObjects`, which deepbook.test.ts checks.
 */
export function deepbookBuyBaseKind(params: {
  pool: DeepBookPool;
  /** Quote units to spend (MIST for a SUI-quoted pool). */
  quoteAmount: bigint;
  /** Minimum base units to accept, else the transaction aborts. */
  minBaseOut: bigint;
  /** Where the output coins go: the derived address. */
  recipient: Uint8Array;
}): Uint8Array {
  const { pool, quoteAmount, minBaseOut, recipient } = params;
  if (quoteAmount <= 0n) throw new Error("quoteAmount must be positive");

  const inputs: PtbInput[] = [
    poolInput(pool, true), // 0
    pureU64(minBaseOut), // 1
    clockInput(), // 2
    pureAddress(recipient), // 3
    pureU64(quoteAmount), // 4
  ];
  const commands: PtbCommand[] = [
    { kind: "splitCoins", coin: GAS_COIN, amounts: [input(4)] }, // 0
    coinZeroCommand(pool.base === DEEPBOOK_TESTNET_DEEP ? pool.base.type : DEEPBOOK_TESTNET_DEEP.type), // 1
    {
      kind: "moveCall",
      packageId: parseHex32(pool.packageId),
      module: "pool",
      function: "swap_exact_quote_for_base",
      typeArguments: poolTypeArgs(pool),
      arguments: [input(0), nested(0, 0), result(1), input(1), input(2)],
    }, // 2
    {
      kind: "transferObjects",
      objects: [nested(2, 0), nested(2, 1), nested(2, 2)],
      address: input(3),
    },
  ];
  return encodeProgrammableKind(inputs, commands);
}

/**
 * Sell base for quote: `swap_exact_base_for_quote`.
 *
 * The base coin cannot come from gas, so the caller passes the owned coin
 * objects the address holds. More than one is merged first. This is the half
 * that proves the derived address owns arbitrary Sui objects and can spend
 * them, not just the SUI it was funded with.
 *
 * `swap_exact_base_for_quote` consumes the whole coin it is given and returns
 * the unfilled remainder, so passing the merged balance sells as much of it
 * as the book can fill and returns the rest.
 */
export function deepbookSellBaseKind(params: {
  pool: DeepBookPool;
  /** Owned coin objects of the pool's base type. At least one. */
  baseCoins: SuiObjectRef[];
  /** Minimum quote units to accept, else the transaction aborts. */
  minQuoteOut: bigint;
  recipient: Uint8Array;
}): Uint8Array {
  const { pool, baseCoins, minQuoteOut, recipient } = params;
  if (baseCoins.length === 0) throw new Error("at least one base coin object is required");

  const inputs: PtbInput[] = [
    poolInput(pool, true), // 0
    pureU64(minQuoteOut), // 1
    clockInput(), // 2
    pureAddress(recipient), // 3
  ];
  for (const c of baseCoins) {
    inputs.push({ kind: "owned", objectId: c.objectId, version: c.version, digest: c.digest });
  }
  const firstCoin = input(4);

  const commands: PtbCommand[] = [];
  if (baseCoins.length > 1) {
    commands.push({
      kind: "mergeCoins",
      destination: firstCoin,
      sources: baseCoins.slice(1).map((_, i) => input(5 + i)),
    });
  }
  // The fee coin. A whitelisted pool takes zero DEEP; passing the traded coin
  // itself would double-spend the input.
  commands.push(coinZeroCommand(DEEPBOOK_TESTNET_DEEP.type));
  const zeroIdx = commands.length - 1;
  commands.push({
    kind: "moveCall",
    packageId: parseHex32(pool.packageId),
    module: "pool",
    function: "swap_exact_base_for_quote",
    typeArguments: poolTypeArgs(pool),
    arguments: [input(0), firstCoin, result(zeroIdx), input(1), input(2)],
  });
  const swapIdx = commands.length - 1;
  commands.push({
    kind: "transferObjects",
    objects: [nested(swapIdx, 0), nested(swapIdx, 1), nested(swapIdx, 2)],
    address: input(3),
  });
  return encodeProgrammableKind(inputs, commands);
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export type DeepBookQuote = {
  /** Mid price, quote per base, for display. */
  midPrice: number;
  /** Raw fixed-point mid price as the pool reports it. */
  midPriceRaw: bigint;
  /** Base units the swap would produce. Zero means it would not fill. */
  baseOut: bigint;
  /** Quote units handed back unfilled. */
  quoteOut: bigint;
  /** DEEP units the pool would charge. Zero on a whitelisted pool. */
  deepRequired: bigint;
  /** Whether the pool charges fees at all. */
  whitelisted: boolean;
};

/**
 * A read-only programmable block: mid price, the swap's output, and whether
 * the pool is whitelisted. Simulated rather than executed, so it costs
 * nothing and needs no signature — the Sui equivalent of the
 * `eth_estimateGas` pre-check the EVM demo runs before touching Solana.
 *
 * `direction` picks which quantity function to call: "buy" spends quote and
 * asks how much base comes out; "sell" spends base and asks for quote.
 */
export function deepbookQuoteKind(params: {
  pool: DeepBookPool;
  direction: "buy" | "sell";
  /** Quote units for a buy, base units for a sell. */
  amount: bigint;
}): Uint8Array {
  const { pool, direction, amount } = params;
  const inputs: PtbInput[] = [poolInput(pool, false), pureU64(amount), clockInput()];
  const typeArguments = poolTypeArgs(pool);
  const packageId = parseHex32(pool.packageId);
  const commands: PtbCommand[] = [
    {
      kind: "moveCall",
      packageId,
      module: "pool",
      function: "mid_price",
      typeArguments,
      arguments: [input(0), input(2)],
    },
    {
      kind: "moveCall",
      packageId,
      module: "pool",
      function: direction === "buy" ? "get_base_quantity_out" : "get_quote_quantity_out",
      typeArguments,
      arguments: [input(0), input(1), input(2)],
    },
    {
      kind: "moveCall",
      packageId,
      module: "pool",
      function: "whitelisted",
      typeArguments,
      arguments: [input(0)],
    },
  ];
  return encodeProgrammableKind(inputs, commands);
}

/**
 * Read a `deepbookQuoteKind` simulation back. `outputs` is the
 * `simulateTransaction { outputs { returnValues { value { json } } } }` shape,
 * one entry per command, in order.
 */
export function decodeDeepbookQuote(
  outputs: Array<Array<string | number | boolean | null>>,
  pool: DeepBookPool,
): DeepBookQuote {
  if (outputs.length < 3) {
    throw new Error(`expected 3 command outputs from the quote block, got ${outputs.length}`);
  }
  const num = (v: string | number | boolean | null | undefined): bigint => {
    if (v === null || v === undefined) throw new Error("missing return value in quote simulation");
    return BigInt(v as string | number);
  };
  const midPriceRaw = num(outputs[0][0]);
  const [baseOut, quoteOut, deepRequired] = [num(outputs[1][0]), num(outputs[1][1]), num(outputs[1][2])];
  return {
    midPriceRaw,
    midPrice: deepbookPrice(midPriceRaw, pool),
    baseOut,
    quoteOut,
    deepRequired,
    whitelisted: outputs[2][0] === true,
  };
}

/** Human-readable reason a quote is not tradeable, or null when it is. */
export function quoteRejection(quote: DeepBookQuote, pool: DeepBookPool, direction: "buy" | "sell"): string | null {
  if (!quote.whitelisted && quote.deepRequired > 0n) {
    return `pool ${pool.key} requires ${formatCoin(quote.deepRequired, DEEPBOOK_TESTNET_DEEP)} DEEP in fees, which the derived address does not hold`;
  }
  if (direction === "buy") {
    if (quote.baseOut === 0n) {
      return `the order book cannot fill this size: it would return the ${pool.quote.symbol} unspent (the pool's minimum is ${formatCoin(pool.minSizeBase, pool.base)} ${pool.base.symbol})`;
    }
    if (quote.baseOut < pool.minSizeBase) {
      return `output ${formatCoin(quote.baseOut, pool.base)} ${pool.base.symbol} is below the pool minimum of ${formatCoin(pool.minSizeBase, pool.base)}`;
    }
  } else if (quote.quoteOut === 0n) {
    return `the order book cannot fill this size (the pool's minimum is ${formatCoin(pool.minSizeBase, pool.base)} ${pool.base.symbol})`;
  }
  return null;
}

/** The concatenation helper re-exported so callers need not import sui-ptb. */
export { concatBytes };
