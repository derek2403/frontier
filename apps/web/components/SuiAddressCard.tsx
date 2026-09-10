// Shows the deterministic Sui address derived from (requester, path, chain
// tag) — the Sui twin of DerivedAddressCard. Same wallet, different chain tag,
// different address: blake2b256(0x01 || compressed_pk) instead of keccak.

import { getSuiChain, MIST_PER_SUI } from "@soda-sdk/core";

// Build-time chain selection, matching pages/sui.tsx. Statically named so
// Next inlines it into the bundle.
const CHAIN = getSuiChain(process.env.NEXT_PUBLIC_SUI_CHAIN);

type Props = {
  suiAddress: string | null;
  balanceMist: bigint | null;
  loading?: boolean;
  /** Why the balance could not be read, if it could not. */
  balanceError?: string | null;
};

export function formatSui(mist: bigint | null): string {
  if (mist === null) return "—";
  return `${(Number(mist) / Number(MIST_PER_SUI)).toFixed(6)} SUI`;
}

export default function SuiAddressCard({
  suiAddress,
  balanceMist,
  loading,
  balanceError,
}: Props) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 text-zinc-100">
      <div className="text-xs uppercase tracking-wider text-zinc-500">
        Solana-derived Sui address
      </div>
      <div className="mt-2 break-all font-mono text-lg">
        {loading ? "deriving…" : suiAddress ?? "—"}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            {CHAIN.name} balance
          </div>
          <div className="mt-1 font-mono">{formatSui(balanceMist)}</div>
          {balanceMist === null && balanceError ? (
            <div className="mt-1 break-all text-xs text-rose-300/80">
              {balanceError}
            </div>
          ) : null}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">Chain</div>
          <div className="mt-1 font-mono">{CHAIN.name}</div>
        </div>
      </div>

      {suiAddress ? (
        <div className="mt-4 text-xs text-zinc-500">
          <a
            href={CHAIN.explorerAddress(suiAddress)}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-zinc-300"
          >
            This address on Suiscan →
          </a>
        </div>
      ) : null}
    </div>
  );
}
