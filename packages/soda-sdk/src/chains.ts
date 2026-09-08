// EVM chain registry.
//
// Everything chain-specific lives here so that adding a chain is a new entry,
// not a hunt through the CLI, the web app, the API routes and the audit tool
// for the places that spelled "11155111". The on-chain program is already
// chain-agnostic: it RLP-encodes whatever chain_id it is given and passes the
// chain_tag straight into the derivation.
//
// chain_tag is a derivation input, so DIFFERENT tags give the same owner
// DIFFERENT addresses per chain. That is deliberate: it is NEAR's "use a
// distinct derivation path per chain" advice, and it means Sepolia keeps the
// tag it has always had, so no existing derived address changes.

import { AAVE_V3_BASE_SEPOLIA, AAVE_V3_SEPOLIA, type AaveV3Addresses } from "./aave";

export type EvmChainKey = "sepolia" | "base-sepolia";

export type EvmChain = {
  key: EvmChainKey;
  name: string;
  chainId: bigint;
  /** 32-byte ASCII tag, zero-padded; feeds the SODA derivation tweak. */
  chainTag: Uint8Array;
  /** Keyless public RPC used when the env var below is unset. */
  defaultRpc: string;
  /** Server-side env var that overrides defaultRpc. */
  rpcEnv: string;
  explorerTx: (hash: string) => string;
  explorerAddress: (addr: string) => string;
  explorerToken: (token: string, holder: string) => string;
  aave: AaveV3Addresses | null;
  faucets: string[];
};

function tag32(s: string): Uint8Array {
  const t = new Uint8Array(32);
  t.set(new TextEncoder().encode(s), 0);
  return t;
}

export const CHAINS: Record<EvmChainKey, EvmChain> = {
  sepolia: {
    key: "sepolia",
    name: "Ethereum Sepolia",
    chainId: 11_155_111n,
    // Must stay byte-identical to the historical ETH_SEPOLIA_CHAIN_TAG.
    chainTag: tag32("ethereum-sepolia"),
    defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com",
    rpcEnv: "SEPOLIA_RPC_URL",
    explorerTx: (h) => `https://sepolia.etherscan.io/tx/${h}`,
    explorerAddress: (a) => `https://sepolia.etherscan.io/address/${a}`,
    explorerToken: (t, a) => `https://sepolia.etherscan.io/token/${t}?a=${a}`,
    aave: AAVE_V3_SEPOLIA,
    faucets: [
      "https://www.alchemy.com/faucets/ethereum-sepolia",
      "https://sepoliafaucet.com/",
      "https://faucet.quicknode.com/ethereum/sepolia",
    ],
  },
  "base-sepolia": {
    key: "base-sepolia",
    name: "Base Sepolia",
    chainId: 84_532n,
    chainTag: tag32("base-sepolia"),
    defaultRpc: "https://sepolia.base.org",
    rpcEnv: "BASE_SEPOLIA_RPC_URL",
    explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}`,
    explorerAddress: (a) => `https://sepolia.basescan.org/address/${a}`,
    explorerToken: (t, a) => `https://sepolia.basescan.org/token/${t}?a=${a}`,
    aave: AAVE_V3_BASE_SEPOLIA,
    faucets: [
      "https://www.alchemy.com/faucets/base-sepolia",
      "https://portal.cdp.coinbase.com/products/faucet",
    ],
  },
};

/** Resolve a chain from DEMO_CHAIN-style input. Unset = Sepolia. */
export function getChain(key: string | undefined | null): EvmChain {
  const k = (key ?? "").trim().toLowerCase() || "sepolia";
  const chain = (CHAINS as Record<string, EvmChain>)[k];
  if (!chain) {
    throw new Error(
      `unknown chain "${key}" — expected one of: ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  return chain;
}

/** Look a chain up by the id recovered from a transaction's EIP-155 `v`. */
export function chainById(chainId: bigint): EvmChain | undefined {
  return Object.values(CHAINS).find((c) => c.chainId === chainId);
}

/**
 * Server-side RPC URL for a chain (env override, else the public default).
 * Not for browser code: Next only inlines statically-named NEXT_PUBLIC_*
 * references, so a dynamic env lookup is always empty there.
 */
export function chainRpcUrl(
  chain: EvmChain,
  env: Record<string, string | undefined> = process.env,
): string {
  const v = env[chain.rpcEnv]?.trim();
  return v && v.length > 0 ? v : chain.defaultRpc;
}
