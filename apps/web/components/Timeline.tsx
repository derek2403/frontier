// Five-step progress display, driven by event-subscription state in the parent.
//
// Status is carried by a word, not only by a mark, so it survives greyscale
// and screen readers. The marks are monochrome except for a genuine failure.

export type Step = "idle" | "active" | "done" | "error";

export type TimelineState = {
  signEthTransfer: Step;
  sigRequested: Step;
  signOffChain: Step;
  finalizeOnChain: Step;
  broadcastEth: Step;
};

const STEPS: Array<{
  key: keyof TimelineState;
  label: string;
  sub: string;
  details?: string[];
}> = [
  {
    key: "signEthTransfer",
    label: "Solana: sign_eth_transfer",
    sub: "Phantom signs. eth_demo builds the RLP and calls into SODA.",
  },
  {
    key: "sigRequested",
    label: "SigRequested emitted",
    sub: "The SigRequest account is created on-chain.",
  },
  {
    key: "signOffChain",
    label: "MPC committee signs",
    sub: "The coordinator relays four messages between P1 and P2.",
    details: [
      "P1 → message 1   commitment to k1·G",
      "P2 → message 2   k2·G with Schnorr proof",
      "P1 → message 3   opens commitment, Schnorr proof",
      "P2 → message 4   Paillier-homomorphic partial signature",
      "P1 decrypts and exports (r, s, recovery_id)",
    ],
  },
  {
    key: "finalizeOnChain",
    label: "Solana: finalize_signature",
    sub: "secp256k1_recover checks the signature against the stored foreign_pk_xy.",
  },
  {
    key: "broadcastEth",
    label: "Broadcast to Sepolia",
    sub: "eth_sendRawTransaction.",
  },
];

const STATUS: Record<Step, string> = {
  idle: "Waiting",
  active: "Running",
  done: "Done",
  error: "Failed",
};

function Marker({ step }: { step: Step }) {
  if (step === "error") {
    return <span className="mt-[7px] block h-2.5 w-2.5 rounded-full bg-error" />;
  }
  if (step === "done") {
    return (
      <span className="mt-[7px] block h-2.5 w-2.5 rounded-full bg-surface-contrast" />
    );
  }
  if (step === "active") {
    return (
      <span className="mt-[7px] block h-2.5 w-2.5 rounded-full border-2 border-strong bg-surface" />
    );
  }
  return (
    <span className="mt-[7px] block h-2.5 w-2.5 rounded-full border border-default bg-surface" />
  );
}

export default function Timeline({ state }: { state: TimelineState }) {
  return (
    <section aria-labelledby="pipeline">
      <h2 id="pipeline" className="text-sm font-medium">
        Pipeline
      </h2>

      <ol className="mt-6">
        {STEPS.map((s, i) => {
          const step = state[s.key];
          const last = i === STEPS.length - 1;
          return (
            <li key={s.key} className="flex gap-4">
              {/* Marker column: the rule connects steps into one sequence. */}
              <div className="flex flex-col items-center">
                <Marker step={step} />
                {!last ? (
                  <span className="my-1.5 w-px flex-1 bg-subtle" aria-hidden />
                ) : null}
              </div>

              <div className={last ? "flex-1" : "flex-1 pb-8"}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span
                    className={
                      step === "idle"
                        ? "text-sm text-tertiary"
                        : "text-sm font-medium"
                    }
                  >
                    {s.label}
                  </span>
                  <span
                    className={
                      step === "error"
                        ? "text-sm text-error"
                        : "text-sm text-secondary"
                    }
                  >
                    {STATUS[step]}
                  </span>
                </div>

                <p className="mt-1 text-sm text-secondary">{s.sub}</p>

                {s.details && step !== "idle" ? (
                  <ol className="mt-3 space-y-1 border-l border-subtle pl-4">
                    {s.details.map((d) => (
                      <li
                        key={d}
                        className="font-mono text-xs whitespace-pre-wrap text-secondary"
                      >
                        {d}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
