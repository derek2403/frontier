// The Ethereum address derived from the committee's group_pk. This is the
// evidence the page exists to show, so it is the focal object rather than one
// card among several: the address gets display scale, and the figures that
// qualify it sit on a shared baseline beneath it.

type Props = {
  ethAddress: string | null;
  sepoliaBalanceWei: bigint | null;
  loading?: boolean;
  /** Base58 pubkey of the connected wallet the address is derived from. */
  derivedFrom?: string | null;
};

const FAUCETS = [
  { name: "Alchemy", href: "https://www.alchemy.com/faucets/ethereum-sepolia" },
  { name: "sepoliafaucet.com", href: "https://sepoliafaucet.com/" },
  { name: "QuickNode", href: "https://faucet.quicknode.com/ethereum/sepolia" },
];

// Below this the demo cannot cover gas, so the run fails before it builds a
// transaction. Same threshold as run-demo.ts.
const FUNDING_THRESHOLD_WEI = 200_000_000_000_000n;

function formatEth(wei: bigint | null): string {
  if (wei === null) return "—";
  return `${(Number(wei) / 1e18).toFixed(6)} ETH`;
}

export default function DerivedAddressCard({
  ethAddress,
  sepoliaBalanceWei,
  loading,
  derivedFrom,
}: Props) {
  const underfunded =
    sepoliaBalanceWei !== null && sepoliaBalanceWei < FUNDING_THRESHOLD_WEI;

  return (
    <section aria-labelledby="derived-address">
      <h2 id="derived-address" className="text-sm text-secondary">
        Your wallet&apos;s Ethereum address
      </h2>

      <p className="mt-3 font-mono text-xl leading-tight break-all sm:text-2xl">
        {loading ? (
          <span className="text-tertiary">deriving…</span>
        ) : (
          ethAddress ?? "—"
        )}
      </p>

      <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-secondary">Sepolia balance</dt>
          <dd className="tabular mt-1.5 font-mono text-base">
            {formatEth(sepoliaBalanceWei)}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-secondary">Chain</dt>
          <dd className="tabular mt-1.5 font-mono text-base">Sepolia · 11155111</dd>
        </div>
        <div>
          <dt className="text-sm text-secondary">Private key</dt>
          <dd className="mt-1.5 text-base">None exists</dd>
        </div>
      </dl>

      {derivedFrom ? (
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-secondary">
          Derived from{" "}
          <span className="font-mono text-primary">{derivedFrom}</span>. The
          SODA program computes this address on-chain from the account that
          signs, so connecting a different wallet produces a different address
          and no caller can request a signature for one that is not theirs.
        </p>
      ) : null}

      {underfunded ? (
        <div className="mt-8 border-l-2 border-warning pl-4">
          <p className="text-sm font-medium text-warning">
            Needs at least 0.0002 Sepolia ETH to cover gas
          </p>
          <p className="mt-1.5 text-sm text-secondary">
            The run stops before building a transaction until this address can
            pay. Fund it at{" "}
            {FAUCETS.map((f, i) => (
              <span key={f.href}>
                {i > 0 ? ", " : ""}
                <a
                  className="underline underline-offset-2 hover:text-primary"
                  href={f.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {f.name}
                </a>
              </span>
            ))}
            .
          </p>
        </div>
      ) : null}
    </section>
  );
}
