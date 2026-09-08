import { useState } from "react";

export default function SignedHexView({ signedRlpHex }: { signedRlpHex: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!signedRlpHex) return null;

  const onCopy = async () => {
    await navigator.clipboard.writeText(signedRlpHex);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-zinc-500">Signed RLP</div>
        <button
          onClick={onCopy}
          className="rounded-md bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div className="mt-3 break-all font-mono text-xs text-zinc-300">
        {signedRlpHex}
      </div>
    </div>
  );
}
