// Aave V3 — the demo's non-trivial actions.
//
// Deposit: native ETH into Aave via the WrappedTokenGatewayV3, so the
// SODA-derived address ends up holding aWETH — a lending position, owned by a
// Solana account.
//
// Borrow: USDC from the Pool against that aWETH. A deposit alone can be read
// as "sent ETH to a contract"; a borrow can only be made by the position's
// owner, and it leaves the derived address holding an asset it never had.
//
// Why the gateway for the deposit and not Pool.supply(): supply() takes an
// ERC-20, which would need a WETH approval transaction first. depositETH()
// takes native ETH via msg.value, so it is ONE transaction with no prior
// setup. Pool.borrow() is likewise one transaction: the Pool mints debt and
// transfers the asset out, nothing to approve.
//
// Addresses are from the official registry, bgd-labs/aave-address-book
// (src/AaveV3Sepolia.sol, src/AaveV3BaseSepolia.sol). Deposit verified
// 2026-09-08 with eth_estimateGas against the live gateway: 229,989 gas for
// 0.0001 ETH. Borrow verified 2026-09-09 the same way on Base Sepolia:
// 288,022 gas for 0.1 USDC from a SODA-derived address holding aWETH.

import { keccak_256 } from "@noble/hashes/sha3";

export type AaveV3Addresses = {
  POOL: string;
  WETH_GATEWAY: string;
  WETH_UNDERLYING: string;
  /** The aToken the depositor receives. ERC-20; balanceOf shows the position. */
  A_WETH: string;
  /** The asset the demo borrows. Aave's own test USDC on testnets, 6 dp. */
  USDC_UNDERLYING: string;
  USDC_DECIMALS: number;
  /** Variable-debt token for USDC; balanceOf shows what the address owes. */
  V_USDC: string;
};

/** bgd-labs/aave-address-book src/AaveV3Sepolia.sol */
export const AAVE_V3_SEPOLIA: AaveV3Addresses = {
  POOL: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  WETH_GATEWAY: "0x387d311e47e80b498169e6fb51d3193167d89F7D",
  WETH_UNDERLYING: "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c",
  A_WETH: "0x5b071b590a59395fE4025A0Ccc1FcC931AAc1830",
  USDC_UNDERLYING: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
  USDC_DECIMALS: 6,
  V_USDC: "0x36B5dE936eF1710E1d22EabE5231b28581a92ECc",
};

/**
 * bgd-labs/aave-address-book src/AaveV3BaseSepolia.sol. Different contracts
 * from Ethereum Sepolia — the gateway, pool and tokens are all chain-local.
 * WETH_UNDERLYING is the canonical OP-stack predeploy. USDC here is Aave's
 * test token, NOT Circle's Base Sepolia USDC (0x036C…), which is not a
 * reserve in this market.
 */
export const AAVE_V3_BASE_SEPOLIA: AaveV3Addresses = {
  POOL: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
  WETH_GATEWAY: "0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6",
  WETH_UNDERLYING: "0x4200000000000000000000000000000000000006",
  A_WETH: "0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb",
  USDC_UNDERLYING: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
  USDC_DECIMALS: 6,
  V_USDC: "0xFB3e85601b7fEb3691bbb8779Ef0E1069E347204",
};

/**
 * Gas limit for depositETH. Measured 229,989; 300k leaves headroom for the
 * state-dependent variance of Aave's interest-index updates.
 */
export const AAVE_DEPOSIT_GAS_LIMIT = 300_000n;

/**
 * Minimum balance the derived address needs before attempting a deposit:
 * 0.0001 ETH deposited + 300k gas at up to ~4.6 gwei. The plain-transfer
 * demo only needs 0.0002, so callers pick the threshold by action.
 */
export const AAVE_DEPOSIT_MIN_BALANCE_WEI = 1_500_000_000_000_000n; // 0.0015 ETH

/** Gas limit for Pool.borrow. Measured 288,022; 400k for index-update variance. */
export const AAVE_BORROW_GAS_LIMIT = 400_000n;

/**
 * Borrow sends no value, so this is gas only: 400k at up to ~3.7 gwei. Kept
 * equal to the deposit threshold so one sponsor top-up covers either action.
 */
export const AAVE_BORROW_MIN_BALANCE_WEI = 1_500_000_000_000_000n; // 0.0015 ETH

/**
 * Amount the demo borrows per click, in USDC base units (6 dp): 0.10 USDC.
 * Small enough that a single 0.0001 ETH deposit (~$0.75 at 82.5% LTV, so
 * ~$0.62 borrowable) covers several borrows before Aave refuses one.
 */
export const AAVE_BORROW_AMOUNT_USDC = 100_000n;

/** Aave interest-rate mode for borrow(): 2 = variable. Stable was retired in V3.1. */
export const AAVE_RATE_MODE_VARIABLE = 2n;

export function addressToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length !== 40) throw new Error(`not a 20-byte address: ${hex}`);
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

function selector(signature: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(signature)).subarray(0, 4);
}

function abiWord(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function abiUint(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("abi uint cannot be negative");
  const hex = v.toString(16).padStart(64, "0");
  if (hex.length !== 64) throw new Error("abi uint overflows 32 bytes");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/**
 * Calldata for `depositETH(address pool, address onBehalfOf, uint16 referralCode)`.
 *
 * `onBehalfOf` is who receives the aWETH. For SODA that is the derived
 * address itself, so the position is held by the Solana-controlled account.
 * The gateway's V3 signature keeps `pool` for interface compatibility.
 *
 * `aave` selects the chain's contract set; it is required rather than
 * defaulted so a Base transaction can never be built with Sepolia's pool.
 */
export function depositEthCalldata(
  aave: AaveV3Addresses,
  onBehalfOf: Uint8Array,
): Uint8Array {
  if (onBehalfOf.length !== 20) throw new Error("onBehalfOf must be 20 bytes");
  const out = new Uint8Array(4 + 32 * 3);
  out.set(selector("depositETH(address,address,uint16)"), 0);
  out.set(abiWord(addressToBytes(aave.POOL)), 4);
  out.set(abiWord(onBehalfOf), 36);
  // referralCode = 0; abiWord of an empty array is 32 zero bytes.
  out.set(abiWord(new Uint8Array(0)), 68);
  return out;
}

/**
 * Calldata for `Pool.borrow(address asset, uint256 amount, uint256
 * interestRateMode, uint16 referralCode, address onBehalfOf)`.
 *
 * Sent TO `aave.POOL` with zero value. `onBehalfOf` must be the caller
 * itself unless the caller holds credit delegation, so for SODA it is the
 * derived address — the same account that holds the aWETH collateral. The
 * borrowed USDC is transferred to msg.sender, which is also that address.
 */
export function borrowCalldata(
  aave: AaveV3Addresses,
  amountBaseUnits: bigint,
  onBehalfOf: Uint8Array,
): Uint8Array {
  if (onBehalfOf.length !== 20) throw new Error("onBehalfOf must be 20 bytes");
  if (amountBaseUnits <= 0n) throw new Error("borrow amount must be positive");
  const out = new Uint8Array(4 + 32 * 5);
  out.set(selector("borrow(address,uint256,uint256,uint16,address)"), 0);
  out.set(abiWord(addressToBytes(aave.USDC_UNDERLYING)), 4);
  out.set(abiUint(amountBaseUnits), 36);
  out.set(abiUint(AAVE_RATE_MODE_VARIABLE), 68);
  out.set(abiUint(0n), 100); // referralCode
  out.set(abiWord(onBehalfOf), 132);
  return out;
}

/** Calldata for ERC-20 `balanceOf(address)`, to read the aWETH position. */
export function erc20BalanceOfCalldata(owner: Uint8Array): Uint8Array {
  if (owner.length !== 20) throw new Error("owner must be 20 bytes");
  const out = new Uint8Array(4 + 32);
  out.set(selector("balanceOf(address)"), 0);
  out.set(abiWord(owner), 4);
  return out;
}

/** Calldata for `Pool.getUserAccountData(address user)`. */
export function getUserAccountDataCalldata(user: Uint8Array): Uint8Array {
  if (user.length !== 20) throw new Error("user must be 20 bytes");
  const out = new Uint8Array(4 + 32);
  out.set(selector("getUserAccountData(address)"), 0);
  out.set(abiWord(user), 4);
  return out;
}

/** Calldata for `Pool.getReserveData(address asset)`. */
export function getReserveDataCalldata(asset: string): Uint8Array {
  const out = new Uint8Array(4 + 32);
  out.set(selector("getReserveData(address)"), 0);
  out.set(abiWord(addressToBytes(asset)), 4);
  return out;
}

function word(hex: string, i: number): bigint {
  const clean = hex.replace(/^0x/, "");
  const w = clean.slice(i * 64, (i + 1) * 64);
  if (w.length !== 64) throw new Error(`abi return too short for word ${i}`);
  return BigInt("0x" + w);
}

export type AaveUserAccountData = {
  /** USD with 8 decimals — Aave's "base currency" on these markets. */
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  /** basis points */
  currentLiquidationThreshold: bigint;
  /** basis points */
  ltv: bigint;
  /** 1e18-scaled; uint256.max when there is no debt. */
  healthFactor: bigint;
};

/** Decode the six-word return of getUserAccountData. */
export function decodeUserAccountData(hex: string): AaveUserAccountData {
  return {
    totalCollateralBase: word(hex, 0),
    totalDebtBase: word(hex, 1),
    availableBorrowsBase: word(hex, 2),
    currentLiquidationThreshold: word(hex, 3),
    ltv: word(hex, 4),
    healthFactor: word(hex, 5),
  };
}

export type AaveReserveRates = {
  /** ray (1e27), per-second-compounded APR for suppliers. */
  currentLiquidityRate: bigint;
  /** ray (1e27), APR for variable borrowers. */
  currentVariableBorrowRate: bigint;
};

/**
 * Decode the rates out of getReserveData's ReserveData struct. Word layout
 * (V3): configuration, liquidityIndex, currentLiquidityRate,
 * variableBorrowIndex, currentVariableBorrowRate, …
 */
export function decodeReserveRates(hex: string): AaveReserveRates {
  return {
    currentLiquidityRate: word(hex, 2),
    currentVariableBorrowRate: word(hex, 4),
  };
}

const RAY = 1e27;
const SECONDS_PER_YEAR = 31_536_000;

/** Aave's APR (ray) → APY as a fraction, compounding per second as the protocol does. */
export function rayRateToApy(rateRay: bigint): number {
  const apr = Number(rateRay) / RAY;
  return Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
}

/** Aave's APR (ray) → APR as a fraction. */
export function rayRateToApr(rateRay: bigint): number {
  return Number(rateRay) / RAY;
}
