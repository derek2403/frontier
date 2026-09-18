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
//
// Non-EVM chains have their own registry next to their encoder (Sui is in
// sui.ts). `chainFamily` is the one switch that tells a caller which one a
// DEMO_CHAIN key belongs to.

import { AAVE_V3_BASE_SEPOLIA, AAVE_V3_SEPOLIA, type AaveV3Addresses } from "./aave";
import { SUI_CHAINS, type SuiChainKey } from "./sui";
import { safeEnv } from "./sui-ptb";

export type EvmChainKey = "sepolia" | "base-sepolia";

export type EvmChain = {
  key: EvmChainKey;
  name: string;
  chainId: bigint;
  /**
   * 32-byte ASCII tag, zero-padded; feeds the SODA derivation tweak.
   *
   * Every EVM chain shares ONE tag, so a wallet has ONE EVM address across
   * Ethereum, Base and any chain added later — the behaviour every wallet
   * already has. Separating per chain would give the same owner a different
   * address on each, which means funding each one, and bridging to yourself
   * landing somewhere you were not looking.
   *
   * It costs nothing in safety: replay is stopped by the EIP-155 chain id
   * inside the signed payload, not by the address. A transaction signed for
   * chain 84532 is invalid on chain 1 whether or not the addresses match.
   *
   * Families still differ (evm / sui / bitcoin) because their address formats
   * and signing envelopes differ anyway.
   *
   * CHANGING A TAG CHANGES EVERY ADDRESS DERIVED UNDER IT. Treat these
   * strings as frozen once real funds exist.
   */
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

/**
 * The single derivation tag for every EVM chain. One wallet, one EVM address,
 * everywhere — see the note on EvmChain.chainTag.
 */
export const EVM_CHAIN_TAG: Uint8Array = tag32("evm");

export const CHAINS: Record<EvmChainKey, EvmChain> = {
  sepolia: {
    key: "sepolia",
    name: "Ethereum Sepolia",
    chainId: 11_155_111n,
    chainTag: EVM_CHAIN_TAG,
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
    chainTag: EVM_CHAIN_TAG,
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

export type ChainKey = EvmChainKey | SuiChainKey;
export type ChainFamily = "evm" | "sui";

/**
 * Which encoder a DEMO_CHAIN key needs. Unset = Sepolia, so "evm". The CLI
 * wrapper, the verify tool and the web routes branch on this once, at the
 * top, instead of each guessing from the key's spelling.
 */
export function chainFamily(key: string | undefined | null): ChainFamily {
  const k = (key ?? "").trim().toLowerCase() || "sepolia";
  if (k in CHAINS) return "evm";
  if (k in SUI_CHAINS) return "sui";
  throw new Error(
    `unknown chain "${key}" — expected one of: ${[...Object.keys(CHAINS), ...Object.keys(SUI_CHAINS)].join(", ")}`,
  );
}

/** Resolve an EVM chain from DEMO_CHAIN-style input. Unset = Sepolia. */
export function getChain(key: string | undefined | null): EvmChain {
  const k = (key ?? "").trim().toLowerCase() || "sepolia";
  const chain = (CHAINS as Record<string, EvmChain>)[k];
  if (!chain) {
    if (k in SUI_CHAINS) {
      throw new Error(
        `"${k}" is a Sui chain — use getSuiChain() / the Sui demo path (chainFamily() tells them apart)`,
      );
    }
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
  env: Record<string, string | undefined> = safeEnv(),
): string {
  const v = env[chain.rpcEnv]?.trim();
  return v && v.length > 0 ? v : chain.defaultRpc;
}
