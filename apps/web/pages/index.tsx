import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";

import DerivedAddressCard from "@/components/DerivedAddressCard";
import SignAndSendButton from "@/components/SignAndSendButton";
import SignedHexView from "@/components/SignedHexView";
import Timeline, { type TimelineState, type Step } from "@/components/Timeline";
import {
  computeTweak,
  deriveForeignPk,
  ETH_SEPOLIA_CHAIN_TAG,
  ethAddressFromPk,
  EthRpc,
} from "soda-sdk";
import { ETH_DEMO_PROGRAM_ID, SODA_PROGRAM_ID } from "@/lib/idls";

const INITIAL_TIMELINE: TimelineState = {
  signEthTransfer: "idle",
  sigRequested: "idle",
  signOffChain: "idle",
  finalizeOnChain: "idle",
  broadcastEth: "idle",
};

const SEPOLIA_RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";
const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "http://127.0.0.1:8899";

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((n) => n.toString(16).padStart(2, "0")).join("");
}

type RunResult = {
  ethAddress: string;
  recipient: string;
  isSelfTransfer: boolean;
  signedHex: string;
  ethTxHash: string;
  signEthTransferTx: string;
  finalizeSignatureTx: string;
  payloadHex: string;
};

export default function Home() {
  const [groupPkHex, setGroupPkHex] = useState<string | null>(null);
  const [ethAddress, setEthAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [timeline, setTimeline] = useState<TimelineState>(INITIAL_TIMELINE);
  const [signedHex, setSignedHex] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipientInput, setRecipientInput] = useState("");

  const sepolia = useMemo(() => new EthRpc(SEPOLIA_RPC), []);

  useEffect(() => {
    fetch("/api/group-pk")
      .then((r) => r.json())
      .then((d: { groupPkHex?: string; error?: string }) => {
        if (d.groupPkHex) setGroupPkHex(d.groupPkHex);
        else if (d.error) setError(d.error);
      })
      .catch((e) => setError(`Could not load dev signer key: ${(e as Error).message}`));
  }, []);

  useEffect(() => {
    if (!groupPkHex) return;
    const groupPk = Uint8Array.from(
      Buffer.from(groupPkHex.replace(/^0x/, ""), "hex"),
    );
    const ethDemoIdBytes = new PublicKey(ETH_DEMO_PROGRAM_ID).toBytes();
    const tweak = computeTweak(ethDemoIdBytes, new Uint8Array(0), ETH_SEPOLIA_CHAIN_TAG);
    const foreignPk = deriveForeignPk(groupPk, tweak);
    setEthAddress(bytesToHex(ethAddressFromPk(foreignPk)));
  }, [groupPkHex]);

  useEffect(() => {
    if (!ethAddress) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const b = await sepolia.getBalance(ethAddress);
        if (!cancelled) setBalance(b);
      } catch {
        /* swallow */
      }
    };
    tick();
    const id = setInterval(tick, 8_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ethAddress, sepolia]);

  const programs = useMemo(
    () => ({ soda: SODA_PROGRAM_ID, ethDemo: ETH_DEMO_PROGRAM_ID }),
    [],
  );

  const onSign = () => {
    if (busy) return;
    setError(null);
    setSignedHex(null);
    setResult(null);
    setTimeline(INITIAL_TIMELINE);
    setBusy(true);

    const params = new URLSearchParams();
    if (recipientInput.trim()) params.set("recipient", recipientInput.trim());
    const url = `/api/run${params.toString() ? `?${params.toString()}` : ""}`;
    const es = new EventSource(url);

    const updateStep = (name: keyof TimelineState, status: Step) => {
      setTimeline((prev) => ({ ...prev, [name]: status }));
    };

    es.addEventListener("step", (e) => {
      const event = JSON.parse((e as MessageEvent).data) as {
        kind: "step";
        name: keyof TimelineState;
        status: Step;
      };
      updateStep(event.name, event.status);
    });

    es.addEventListener("done", (e) => {
      const r = JSON.parse((e as MessageEvent).data) as RunResult;
      setResult(r);
      setSignedHex(r.signedHex);
      setBusy(false);
      es.close();
    });

    es.addEventListener("fail", (e) => {
      const err = JSON.parse((e as MessageEvent).data ?? "{}") as { message?: string };
      setError(err.message ?? "demo failed");
      setBusy(false);
      setTimeline((prev) => {
        const next = { ...prev };
        (Object.keys(next) as (keyof TimelineState)[]).forEach((k) => {
          if (next[k] === "active") next[k] = "error";
        });
        return next;
      });
      es.close();
    });

    es.onerror = () => {
      if (!busy) return;
      es.close();
    };
  };

  const isFunded = balance !== null && balance >= 200_000_000_000_000n;
  const buttonDisabled = !isFunded || balance === null || !ethAddress;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-xl font-semibold">SODA</div>
            <div className="text-sm text-zinc-500">Chain Signatures for Solana</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            A Solana program just signed an Ethereum transaction.
          </h1>
          <p className="mt-3 text-zinc-400">
            The address below is owned by an <code className="font-mono">eth_demo</code>{" "}
            program PDA on Solana — no private key. Solana&apos;s{" "}
            <code className="font-mono">secp256k1_recover</code> syscall verifies the
            signature on-chain, then it&apos;s broadcast to Sepolia.
          </p>
        </div>

        <div className="grid gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm font-mono text-zinc-400">
          <div>SODA program:    {programs.soda}</div>
          <div>eth_demo program: {programs.ethDemo}</div>
          <div>Solana RPC:      {SOLANA_RPC}</div>
        </div>

        <DerivedAddressCard
          ethAddress={ethAddress}
          sepoliaBalanceWei={balance}
          loading={!groupPkHex}
        />

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-3">
          <label className="block text-xs uppercase tracking-wider text-zinc-500">
            Recipient (optional — defaults to self-transfer)
          </label>
          <input
            type="text"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            placeholder={ethAddress ?? "0x…"}
            disabled={busy}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <SignAndSendButton
          disabled={buttonDisabled}
          busy={busy}
          onClick={onSign}
        />

        {error ? (
          <div className="rounded-lg bg-rose-950/40 border border-rose-900 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <Timeline state={timeline} />

        <SignedHexView signedRlpHex={signedHex} />

        {result ? (
          <div className="rounded-2xl border border-emerald-800 bg-emerald-950/30 p-6 space-y-3">
            <div className="text-xs uppercase tracking-wider text-emerald-400">
              Done — open in Etherscan
            </div>
            <a
              href={`https://sepolia.etherscan.io/tx/${result.ethTxHash}`}
              target="_blank"
              rel="noreferrer"
              className="block break-all font-mono text-sm text-emerald-200 underline hover:text-emerald-100"
            >
              https://sepolia.etherscan.io/tx/{result.ethTxHash}
            </a>
            <div className="grid grid-cols-1 gap-1 pt-2 text-xs font-mono text-emerald-300/70 sm:grid-cols-[auto_1fr] sm:gap-x-4">
              <span className="text-emerald-300/50">from</span>
              <span className="break-all">
                {result.ethAddress} (controlled by Solana, no private key)
              </span>
              <span className="text-emerald-300/50">to</span>
              <span className="break-all">
                {result.recipient}
                {result.isSelfTransfer ? "  (self-transfer)" : ""}
              </span>
              <span className="text-emerald-300/50">value</span>
              <span>0.0001 ETH</span>
              <span className="text-emerald-300/50">sign_eth_transfer</span>
              <span className="break-all">{result.signEthTransferTx}</span>
              <span className="text-emerald-300/50">finalize_signature</span>
              <span className="break-all">{result.finalizeSignatureTx}</span>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
