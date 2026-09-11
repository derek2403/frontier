// Aave V3 on Ethereum Sepolia.
//
// The demo's first non-trivial action: deposit native ETH into Aave via the
// WrappedTokenGatewayV3, so the SODA-derived address ends up holding aWETH —
// a lending position, owned by a Solana account.
//
// Why the gateway and not Pool.supply(): supply() takes an ERC-20, which
// would need a WETH approval transaction first. depositETH() takes native
// ETH via msg.value, so it is ONE transaction with no prior setup — the only
// thing the derived address needs is ETH, which the sponsor provides.
//
// Addresses are from the official registry, bgd-labs/aave-address-book
// (src/AaveV3Sepolia.sol). Verified 2026-09-08 with eth_estimateGas against
// the live gateway: 229,989 gas for a 0.0001 ETH deposit.

import { keccak_256 } from "@noble/hashes/sha3";

export type AaveV3Addresses = {
  POOL: string;
  WETH_GATEWAY: string;
  WETH_UNDERLYING: string;
  /** The aToken the depositor receives. ERC-20; balanceOf shows the position. */
  A_WETH: string;
};

/** bgd-labs/aave-address-book src/AaveV3Sepolia.sol */
export const AAVE_V3_SEPOLIA: AaveV3Addresses = {
  POOL: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  WETH_GATEWAY: "0x387d311e47e80b498169e6fb51d3193167d89F7D",
  WETH_UNDERLYING: "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c",
  A_WETH: "0x5b071b590a59395fE4025A0Ccc1FcC931AAc1830",
};

/**
 * bgd-labs/aave-address-book src/AaveV3BaseSepolia.sol. Different contracts
 * from Ethereum Sepolia — the gateway, pool and aToken are all chain-local.
 * WETH_UNDERLYING is the canonical OP-stack predeploy.
 */
export const AAVE_V3_BASE_SEPOLIA: AaveV3Addresses = {
  POOL: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
  WETH_GATEWAY: "0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6",
  WETH_UNDERLYING: "0x4200000000000000000000000000000000000006",
  A_WETH: "0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb",
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

/** Calldata for ERC-20 `balanceOf(address)`, to read the aWETH position. */
export function erc20BalanceOfCalldata(owner: Uint8Array): Uint8Array {
  if (owner.length !== 20) throw new Error("owner must be 20 bytes");
  const out = new Uint8Array(4 + 32);
  out.set(selector("balanceOf(address)"), 0);
  out.set(abiWord(owner), 4);
  return out;
}
