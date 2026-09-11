// The button that kicks off the whole pipeline. The label follows the
// selected action so the button says what the signature will actually do.

type Props = {
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  onClick: () => void | Promise<void>;
};

export default function SignAndSendButton({
  disabled,
  busy,
  label = "Sign & broadcast 0.0001 ETH (self-transfer)",
  onClick,
}: Props) {
  return (
    <button
      disabled={disabled || busy}
      onClick={() => void onClick()}
      className="w-full rounded-2xl bg-emerald-500 px-6 py-4 text-base font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
    >
      {busy ? "Signing…" : label}
    </button>
  );
}
