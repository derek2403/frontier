// Server-side chain selection for the API routes.
//
// The browser bundle picks its chain from NEXT_PUBLIC_DEMO_CHAIN (inlined at
// build time). The API routes used to read a *different* variable,
// DEMO_CHAIN, so a deployment that set one and not the other derived a
// Base Sepolia address in the browser and then funded and broadcast on
// Ethereum Sepolia — and the only symptom was an RPC error from the wrong
// chain. One variable now drives both: the server falls back to the public
// one, and every route checks the chain the browser says it is on.
//
// The Sui page has its own pair (NEXT_PUBLIC_SUI_CHAIN / SUI_CHAIN) with the
// same fallback and the same per-request check, so the two demos can point at
// different networks without one variable meaning two things.

import {
  getChain,
  getSuiChain,
  type EvmChain,
  type EvmChainKey,
  type SuiChain,
  type SuiChainKey,
} from "@soda-sdk/core";

export function serverChain(): EvmChain {
  // `||`, not `??`: a dashboard variable saved with an empty value is "" and
  // must fall through to the public one, exactly like an unset variable.
  return getChain(
    process.env.DEMO_CHAIN?.trim() || process.env.NEXT_PUBLIC_DEMO_CHAIN,
  );
}

/**
 * Returns an error message if the chain the browser was built for is not the
 * chain this server is configured for, else null. A missing `requested` is
 * accepted so curl-style callers keep working.
 */
export function chainMismatch(
  requested: unknown,
  server: EvmChain,
): string | null {
  if (requested == null || requested === "") return null;
  if (requested === server.key) return null;
  return (
    `chain mismatch: the page was built for "${String(requested)}" but the ` +
    `server is configured for "${server.key}". Set NEXT_PUBLIC_DEMO_CHAIN ` +
    `(and DEMO_CHAIN, if set) to the same value and redeploy.`
  );
}

/** Sui network for /api/sui/*. Unset = testnet, matching the CLI's default. */
export function serverSuiChain(): SuiChain {
  return getSuiChain(
    process.env.SUI_CHAIN?.trim() || process.env.NEXT_PUBLIC_SUI_CHAIN,
  );
}

/** Same contract as chainMismatch, for the Sui pair of variables. */
export function suiChainMismatch(
  requested: unknown,
  server: SuiChain,
): string | null {
  if (requested == null || requested === "") return null;
  if (requested === server.key) return null;
  return (
    `chain mismatch: the page was built for "${String(requested)}" but the ` +
    `server is configured for "${server.key}". Set NEXT_PUBLIC_SUI_CHAIN ` +
    `(and SUI_CHAIN, if set) to the same value and redeploy.`
  );
}

export type { EvmChainKey, SuiChainKey };
