// Shows the deterministic ETH address derived from (eth_demo program ID, seeds,
// chain tag) — same address every load until keyshare.dev.json changes server-side.

type Props = {
  ethAddress: string | null;
  sepoliaBalanceWei: bigint | null;
  loading?: boolean;
};

const FAUCETS = [
  { name: "Alchemy Sepolia faucet", href: "https://www.alchemy.com/faucets/ethereum-sepolia" },
  { name: "sepoliafaucet.com", href: "https://sepoliafaucet.com/" },
  { name: "QuickNode Sepolia faucet", href: "https://faucet.quicknode.com/ethereum/sepolia" },
];

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
            Sepolia balance
          </div>
          <div className="mt-1 font-mono">{formatEth(sepoliaBalanceWei)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">Chain</div>
          <div className="mt-1 font-mono">Sepolia (11155111)</div>
        </div>
      </div>

      {sepoliaBalanceWei !== null && sepoliaBalanceWei < 200_000_000_000_000n ? (
        <div className="mt-6 rounded-lg bg-amber-950/40 border border-amber-900 p-3 text-sm text-amber-200">
          <div className="font-medium">Address needs ~0.001 Sepolia ETH</div>
          <ul className="mt-2 space-y-1">
            {FAUCETS.map((f) => (
              <li key={f.href}>
                <a className="underline hover:text-amber-100" href={f.href} target="_blank" rel="noreferrer">
                  {f.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
