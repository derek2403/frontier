// Five-step progress display, driven by event-subscription state in the parent.
//
// The pipeline has the same five stages on every chain — a Solana ix that
// commits the payload, the SigRequest, the off-chain signature,
// finalize_signature, and the foreign broadcast — so the component takes the
// stage labels as a prop and only the words change per chain. The EVM labels
// are the default so the original page needs no changes.

export type Step = "idle" | "active" | "done" | "error";

export type TimelineKey =
  | "signEthTransfer"
  | "sigRequested"
  | "signOffChain"
  | "finalizeOnChain"
  | "broadcastEth";

export type TimelineState<K extends string = TimelineKey> = Record<K, Step>;

export type TimelineStep<K extends string = TimelineKey> = {
  key: K;
  label: string;
  sub: string;
  /** Which program or deployed service does this step. */
  actor?: string;
  details?: string[];
};

export const EVM_TIMELINE_STEPS: TimelineStep[] = [
  {
    key: "signEthTransfer",
    label: "Solana: sign_eth_transfer",
    sub: "Your wallet is the only human approval in the whole run",
    actor: "eth_demo program · Solana devnet",
    details: [
      "eth_demo builds the EVM transaction on-chain and keccaks it,",
      "then CPIs soda::request_signature.",
      "soda derives foreign_pk = group_pk + tweak·G ITSELF, from the",
      "signing account — you never name an address, so you cannot ask",
      "for one you do not own.",
    ],
  },
  {
    key: "sigRequested",
    label: "SigRequested emitted",
    sub: "The request is now a fact on Solana, not a message to a server",
    actor: "soda program · SigRequest PDA",
    details: [
      "The PDA stores requester, payload, chain_tag and foreign_pk_xy.",
      "Everything after this reads from that account. Nothing downstream",
      "is trusted to describe the request correctly.",
    ],
  },
  {
    key: "signOffChain",
    label: "The committee signs",
    sub: "Two nodes, one signature, neither holds the key",
    actor: "soda-mpc-coordinator → soda-mpc-node-p1 + p2",
    details: [
      "soda-mpc-subscriber sees the event and sends only the account address.",
      "p1 and p2 each read that account from their OWN Solana RPC and",
      "re-derive the tweak — a compromised caller cannot choose the payload.",
      "",
      "tweak  = sha256(\"SODA-v1\" || owner || path || chain_tag)",
      "The key is shared multiplicatively (Q = x1·x2·G), so the tweak goes",
      "into the MESSAGE instead of a share:",
      "  s = k⁻¹(m + r·(x+t)) = k⁻¹((m + r·t) + r·x)",
      "Signing m + r·t under the committee key therefore yields a valid",
      "signature for group_pk + tweak·G on the real payload.",
      "",
      "4-message Lindell '17, p1 → p2 → p1 → p2 → p1. ~0.9s.",
    ],
  },
  {
    key: "finalizeOnChain",
    label: "Solana: finalize_signature",
    sub: "The chain checks the signature before the foreign chain ever sees it",
    actor: "soda program · secp256k1_recover syscall",
    details: [
      "secp256k1_recover(payload, sig, recovery_id) must equal the",
      "foreign_pk_xy the program derived at request time.",
      "On a mismatch the request stays incomplete and nothing is broadcast.",
      "",
      "Submitted by soda-mpc-subscriber, or by this page if it gets there",
      "first. Either is fine — the program refuses a second signature.",
    ],
  },
  {
    key: "broadcastEth",
    label: "Broadcast to Base Sepolia",
    sub: "Assembled from the signature the chain recorded, not the one we computed",
    actor: "soda-relayer · eth_sendRawTransaction",
    details: [
      "soda-relayer caches the unsigned RLP from EthTxRequested, waits for",
      "SigCompleted, joins them with v = recovery_id + 35 + 2·chain_id,",
      "and submits. It runs whether or not anyone is watching this page.",
      "",
      "It can only broadcast what the chain already verified, so hacking",
      "the relayer delays a transaction — it cannot forge one.",
    ],
  },
];

function dot(step: Step) {
  const base = "h-3 w-3 rounded-full";
  if (step === "done") return <div className={`${base} bg-emerald-500`} />;
  if (step === "active") return <div className={`${base} bg-amber-400 animate-pulse`} />;
  if (step === "error") return <div className={`${base} bg-rose-500`} />;
  return <div className={`${base} bg-zinc-700`} />;
}

export default function Timeline<K extends string = TimelineKey>({
  state,
  steps,
}: {
  state: TimelineState<K>;
  /** Stage labels; omitted = the EVM pipeline. Keys must match `state`. */
  steps?: TimelineStep<K>[];
}) {
  // When `steps` is omitted, K is the default key set by construction, so the
  // EVM list is the right shape; TS cannot see that through the generic.
  const list = steps ?? (EVM_TIMELINE_STEPS as unknown as TimelineStep<K>[]);
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="text-xs uppercase tracking-wider text-zinc-500">Pipeline</div>
      <ol className="mt-4 space-y-4">
        {list.map((s, i) => {
          const step = state[s.key];
          return (
            <li key={s.key} className="flex items-start gap-3">
              <div className="flex flex-col items-center pt-1">
                {dot(step)}
                {i < list.length - 1 ? <div className="mt-1 h-8 w-px bg-zinc-800" /> : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className={step === "idle" ? "text-zinc-500" : "text-zinc-100"}>
                  {s.label}
                </div>
                {s.actor ? (
                  <div
                    className={`mt-0.5 font-mono text-[11px] ${
                      step === "idle" ? "text-zinc-600" : "text-emerald-400/70"
                    }`}
                  >
                    {s.actor}
                  </div>
                ) : null}
                <div className="mt-0.5 text-xs text-zinc-500">{s.sub}</div>
                {s.details && step !== "idle" ? (
                  // `whitespace-pre-wrap` so a blank entry stays a blank line
                  // and long lines wrap instead of scrolling the rail.
                  <div className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-zinc-950/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-emerald-300/70">
                    {s.details.join("\n")}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
