// The button that kicks off the whole pipeline. Live wiring lands in the next
// task; for now this is a stub that just calls onClick so the parent can simulate
// state transitions while the layout is being built.

type Props = {
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void | Promise<void>;
};

export default function SignAndSendButton({ disabled, busy, onClick }: Props) {
  return (
    <button
      disabled={disabled || busy}
      onClick={() => void onClick()}
      className="w-full rounded-2xl bg-emerald-500 px-6 py-4 text-base font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
    >
      {busy ? "Signing…" : "Sign & broadcast 0.0001 ETH (self-transfer)"}
    </button>
  );
}
