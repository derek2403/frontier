// Primary action. Monochrome: it is the only filled control on the page, so
// contrast alone makes it the obvious next step. Green would have claimed a
// meaning the button does not carry.

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
      className="h-11 w-full rounded-md bg-surface-contrast px-5 text-sm font-medium text-on-contrast transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
    >
      {busy ? "Signing…" : "Sign and broadcast 0.0001 ETH"}
    </button>
  );
}
