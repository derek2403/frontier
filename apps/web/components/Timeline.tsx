// Five-step progress display, driven by event-subscription state in the parent.

export type Step = "idle" | "active" | "done" | "error";

export type TimelineState = {
  signEthTransfer: Step;
  sigRequested: Step;
  signOffChain: Step;
  finalizeOnChain: Step;
  broadcastEth: Step;
};

const STEPS: Array<{ key: keyof TimelineState; label: string; sub: string }> = [
  { key: "signEthTransfer", label: "Solana: sign_eth_transfer", sub: "eth_demo builds RLP, CPIs SODA" },
  { key: "sigRequested",    label: "SigRequested emitted",      sub: "request stored in PDA" },
  { key: "signOffChain",    label: "Off-chain ECDSA sign",      sub: "k256 signs payload with tweaked SK" },
  { key: "finalizeOnChain", label: "Solana: finalize_signature", sub: "secp256k1_recover verifies on-chain" },
  { key: "broadcastEth",    label: "Broadcast to Sepolia",       sub: "eth_sendRawTransaction" },
];

function dot(step: Step) {
  const base = "h-3 w-3 rounded-full";
  if (step === "done") return <div className={`${base} bg-emerald-500`} />;
  if (step === "active") return <div className={`${base} bg-amber-400 animate-pulse`} />;
  if (step === "error") return <div className={`${base} bg-rose-500`} />;
  return <div className={`${base} bg-zinc-700`} />;
}

export default function Timeline({ state }: { state: TimelineState }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="text-xs uppercase tracking-wider text-zinc-500">Pipeline</div>
      <ol className="mt-4 space-y-4">
        {STEPS.map((s, i) => {
          const step = state[s.key];
          return (
            <li key={s.key} className="flex items-start gap-3">
              <div className="flex flex-col items-center pt-1">
                {dot(step)}
                {i < STEPS.length - 1 ? <div className="mt-1 h-8 w-px bg-zinc-800" /> : null}
              </div>
              <div className="flex-1">
                <div className={step === "idle" ? "text-zinc-500" : "text-zinc-100"}>
                  {s.label}
                </div>
                <div className="text-xs text-zinc-500">{s.sub}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
