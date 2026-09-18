// Shows the deterministic ETH address derived from (requester, path, chain
// tag) — the same address every load for a given wallet, and a different one
// per wallet, per salt, and per chain.

import { getChain } from "@soda-sdk/core";

// Build-time chain selection, matching pages/index.tsx and the CLI's
// DEMO_CHAIN. Statically named so Next inlines it into the bundle.
const CHAIN = getChain(process.env.NEXT_PUBLIC_DEMO_CHAIN);

export type DerivationDetail = {
  requesterHex: string;
  pathText: string;
  pathHex: string;
  chainTagHex: string;
  tweakHex: string;
  foreignPkHex: string;
};

type Props = {
  ethAddress: string | null;
  sepoliaBalanceWei: bigint | null;
  loading?: boolean;
  /** Why the balance could not be read, if it could not. */
  balanceError?: string | null;
  /** The salt (derivation path). Controlled by the page. */
  path?: string;
  onPathChange?: (next: string) => void;
  pathTooLong?: boolean;
  pathByteLength?: number;
  maxPathBytes?: number;
  /** The inputs the shown address was derived from. */
  derivation?: DerivationDetail | null;
};

function formatEth(wei: bigint | null): string {
  if (wei === null) return "—";
  const eth = Number(wei) / 1e18;
  return `${eth.toFixed(6)} ETH`;
}

/** One labelled row of the proof panel. Long hex wraps rather than clips. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <div className="font-mono text-[11px] text-zinc-500">{label}</div>
      <div className="break-all font-mono text-[11px] text-zinc-300">
        {value}
      </div>
    </div>
  );
}

export default function DerivedAddressCard({
  ethAddress,
  sepoliaBalanceWei,
  loading,
  balanceError,
  path = "",
  onPathChange,
  pathTooLong = false,
  pathByteLength = 0,
  maxPathBytes = 64,
  derivation,
}: Props) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 text-zinc-100">
      <div className="text-xs uppercase tracking-wider text-zinc-500">
        Solana-derived ETH address
      </div>

      {/* The address links out, so a viewer can check it on the explorer
          rather than take the page's word for it. */}
      <div className="mt-2 break-all font-mono text-lg">
        {loading ? (
          "deriving…"
        ) : ethAddress ? (
          <a
            href={CHAIN.explorerAddress(ethAddress)}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-zinc-700 underline-offset-4 transition hover:decoration-zinc-400"
            title={`View on ${CHAIN.name} explorer`}
          >
            {ethAddress}
          </a>
        ) : (
          "—"
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            {CHAIN.name} balance
          </div>
          <div className="mt-1 font-mono">{formatEth(sepoliaBalanceWei)}</div>
          {sepoliaBalanceWei === null && balanceError ? (
            <div className="mt-1 break-all text-xs text-rose-300/80">
              {balanceError}
            </div>
          ) : null}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Chain
          </div>
          <div className="mt-1 font-mono">
            {CHAIN.name} ({CHAIN.chainId.toString()})
          </div>
        </div>
      </div>

      {ethAddress && CHAIN.aave ? (
        <a
          href={CHAIN.explorerToken(CHAIN.aave.A_WETH, ethAddress)}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block text-xs text-zinc-400 underline underline-offset-4 hover:text-zinc-200"
        >
          aWETH position for this address on {CHAIN.name} →
        </a>
      ) : null}

      {/* ---------- salt ---------- */}
      {onPathChange ? (
        <div className="mt-6 border-t border-zinc-800 pt-5">
          <label
            htmlFor="soda-salt"
            className="text-xs uppercase tracking-wider text-zinc-500"
          >
            Salt (derivation path)
          </label>
          <p className="mt-1 text-xs text-zinc-500">
            One wallet can own many addresses. The address above updates as
            you type. Empty is your default account.
          </p>
          <input
            id="soda-salt"
            type="text"
            value={path}
            onChange={(e) => onPathChange(e.target.value)}
            placeholder="e.g. treasury, hedge-1, vault/2"
            spellCheck={false}
            className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none"
          />
          <div className="mt-2 text-xs">
            {pathTooLong ? (
              <span className="text-rose-300">
                {pathByteLength} bytes. The program accepts at most{" "}
                {maxPathBytes}.
              </span>
            ) : (
              <span className="text-zinc-600">
                {pathByteLength} / {maxPathBytes} bytes
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* ---------- the proof ---------- */}
      {derivation ? (
        <details className="group mt-5 border-t border-zinc-800 pt-5">
          <summary className="cursor-pointer list-none text-xs uppercase tracking-wider text-zinc-500 transition hover:text-zinc-300">
            <span className="inline-block w-4 transition group-open:rotate-90">
              ›
            </span>
            Show the exact inputs
          </summary>

          <div className="mt-4 grid gap-2">
            <Row label="domain" value={'"SODA-v1"'} />
            <Row label="requester" value={derivation.requesterHex} />
            <Row
              label="path"
              value={
                derivation.pathText
                  ? `"${derivation.pathText}" = ${derivation.pathHex}`
                  : derivation.pathHex
              }
            />
            <Row label="chain_tag" value={derivation.chainTagHex} />
            <Row label="tweak" value={derivation.tweakHex} />
            <Row label="foreign_pk" value={derivation.foreignPkHex} />
          </div>

          <p className="mt-4 text-xs text-zinc-500">
            These are the same bytes{" "}
            <code className="font-mono">soda::request_signature</code> hashes
            on-chain. Recompute them yourself:
          </p>

          <pre className="mt-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-[11px] leading-relaxed text-zinc-300">
{`import {
  computeTweak, deriveForeignPk, ethAddressFromPk, getChain,
} from "@soda-sdk/core";
import { PublicKey } from "@solana/web3.js";

const chain    = getChain("${CHAIN.key}");
const group_pk = /* Committee.group_pk, from /api/group-pk */;

const tweak = computeTweak(
  new PublicKey("YOUR_WALLET").toBytes(),   // requester
  new TextEncoder().encode(${JSON.stringify(derivation.pathText)}),  // path
  chain.chainTag,
);

const foreign_pk = deriveForeignPk(group_pk, tweak);  // group_pk + tweak·G
const address    = ethAddressFromPk(foreign_pk);      // keccak256(pk)[12:]
// → ${ethAddress ?? "0x…"}`}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
