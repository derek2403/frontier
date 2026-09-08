// Shows the deterministic ETH address derived from (requester, path, chain
// tag) — the same address every load for a given wallet, and a different one
// per wallet and per chain.

import { getChain } from "@soda-sdk/core";

// Build-time chain selection, matching pages/index.tsx and the CLI's
// DEMO_CHAIN. Statically named so Next inlines it into the bundle.
const CHAIN = getChain(process.env.NEXT_PUBLIC_DEMO_CHAIN);

type Props = {
  ethAddress: string | null;
  sepoliaBalanceWei: bigint | null;
  loading?: boolean;
};

function formatEth(wei: bigint | null): string {
  if (wei === null) return "—";
  const eth = Number(wei) / 1e18;
  return `${eth.toFixed(6)} ETH`;
}

export default function DerivedAddressCard({ ethAddress, sepoliaBalanceWei, loading }: Props) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 text-zinc-100">
      <div className="text-xs uppercase tracking-wider text-zinc-500">
        Solana-derived ETH address
      </div>
      <div className="mt-2 break-all font-mono text-lg">
        {loading ? "deriving…" : ethAddress ?? "—"}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            {CHAIN.name} balance
          </div>
          <div className="mt-1 font-mono">{formatEth(sepoliaBalanceWei)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">Chain</div>
          <div className="mt-1 font-mono">
            {CHAIN.name} ({CHAIN.chainId.toString()})
          </div>
        </div>
      </div>

      {/* Funding is automatic from the sponsor key, so this is a fallback for
          when the sponsor is unset or dry — not the normal path. */}
      {sepoliaBalanceWei !== null && sepoliaBalanceWei < 1_500_000_000_000_000n ? (
        <div className="mt-6 rounded-lg bg-amber-950/40 border border-amber-900 p-3 text-sm text-amber-200">
          <div className="font-medium">
            Will be topped up automatically on sign
          </div>
          <div className="mt-1 text-xs text-amber-200/70">
            The sponsor key funds this address before broadcasting. If that is
            unavailable, fund it manually:
          </div>
          <ul className="mt-2 space-y-1">
            {CHAIN.faucets.map((href) => (
              <li key={href}>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all underline hover:text-amber-100"
                >
                  {href}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {ethAddress && CHAIN.aave ? (
        <div className="mt-4 text-xs text-zinc-500">
          <a
            href={CHAIN.explorerToken(CHAIN.aave.A_WETH, ethAddress)}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-zinc-300"
          >
            aWETH position for this address on {CHAIN.name} →
          </a>
        </div>
      ) : null}
    </div>
  );
}
