import { useState } from "react";

// The raw signed transaction, kept as audit-path evidence: quiet, available,
// and never competing with the result above it.

export default function SignedHexView({
  signedRlpHex,
}: {
  signedRlpHex: string | null;
}) {
  const [copied, setCopied] = useState(false);
  if (!signedRlpHex) return null;

  const onCopy = async () => {
    await navigator.clipboard.writeText(signedRlpHex);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section aria-labelledby="signed-rlp" className="mt-12">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="signed-rlp" className="text-sm font-medium">
          Signed transaction
        </h2>
        <button
          onClick={onCopy}
          className="text-sm text-secondary underline-offset-4 transition hover:text-primary hover:underline"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-3 font-mono text-sm leading-relaxed break-all text-secondary">
        {signedRlpHex}
      </p>
    </section>
  );
}
