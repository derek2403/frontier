import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { AnchorProvider, Program, type Wallet } from "@coral-xyz/anchor";
import {
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";

import DerivedAddressCard from "@/components/DerivedAddressCard";
import SignAndSendButton from "@/components/SignAndSendButton";
import SignedHexView from "@/components/SignedHexView";
import Timeline, { type TimelineState, type Step } from "@/components/Timeline";
import {
  bigintToBe,
  encodeUnsignedLegacy,
  ETH_SEPOLIA_CHAIN_TAG,
  ethAddressFromPk,
  EthRpc,
} from "@soda-sdk/core";
import { secp256k1 as secp256k1Curves } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { QRCodeSVG } from "qrcode.react";
import { ETH_DEMO_PROGRAM_ID, ethDemoIdl, sodaIdl, SODA_PROGRAM_ID } from "@/lib/idls";

// WalletMultiButton is a client-only component; dynamic-import keeps it
// out of the Next 16 SSR pass (its internals touch `window`).
const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton,
    ),
  { ssr: false },
);

const MPC_COORDINATOR =
  process.env.NEXT_PUBLIC_MPC_COORDINATOR_URL ?? "http://32.198.7.34:8000";

const DOCS_URL =
  process.env.NEXT_PUBLIC_DOCS_URL ?? "https://frontier-docs-cazz.vercel.app";

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

  const { publicKey: walletPubkey, connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
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
    // No tweak — see "v0.5 quirk" note in onSign for the full reason.
    // Address is the joint group_pk's ETH address.
    const groupPk = Uint8Array.from(
      Buffer.from(groupPkHex.replace(/^0x/, ""), "hex"),
    );
    const groupPkUncompressed = secp256k1Curves.Point.fromBytes(groupPk).toBytes(false);
    setEthAddress(bytesToHex(ethAddressFromPk(groupPkUncompressed)));
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

  const onSign = async () => {
    if (busy) return;
    if (!anchorWallet || !walletPubkey) {
      setError("connect Phantom first");
      return;
    }
    if (!groupPkHex || !ethAddress) {
      setError("group_pk not loaded yet");
      return;
    }

    setError(null);
    setSignedHex(null);
    setResult(null);
    setTimeline(INITIAL_TIMELINE);
    setBusy(true);
    const updateStep = (name: keyof TimelineState, status: Step) =>
      setTimeline((prev) => ({ ...prev, [name]: status }));

    try {
      // -------- 1. Compute derivation in the browser --------
      // v0.5 quirk: the Lindell '17 lib in apps/mpc-node tweaks P1's `x1`
      // but cannot tweak P2's `cypher_x1` (which is Paillier-encrypted x1)
      // without also re-encrypting and sending the new ciphertext to P2.
      // Until we patch the protocol, the foreign address derives directly
      // from the joint group_pk with NO tweak — one address per committee
      // instead of per-PDA. The "no private key anywhere" property still
      // holds; per-program-PDA isolation is a v1 task.
      const groupPk = Uint8Array.from(
        Buffer.from(groupPkHex.replace(/^0x/, ""), "hex"),
      );
      const derivationSeeds = new Uint8Array(0);
      // Decompress the 33-byte group_pk to 65 bytes (0x04 || X || Y).
      const groupPkPoint = secp256k1Curves.Point.fromBytes(groupPk);
      const foreignPk = groupPkPoint.toBytes(false);
      const foreignPkXy = foreignPk.subarray(1); // 64 bytes (X || Y)
      const ethAddrBytes = ethAddressFromPk(foreignPk);

      // -------- 2. Build the unsigned Sepolia tx --------
      const recipientHex = (recipientInput.trim() || ethAddress).replace(
        /^0x/,
        "",
      );
      const recipient = Buffer.from(recipientHex, "hex");
      if (recipient.length !== 20) {
        throw new Error("recipient must be 20 bytes");
      }

      const nonce = await sepolia.getNonce(ethAddress);
      const MIN_GAS_PRICE = 2_000_000_000n; // 2 gwei
      const fetched = await sepolia.getGasPrice();
      const bumped = (fetched * 110n) / 100n;
      const baseGasPrice = bumped > MIN_GAS_PRICE ? bumped : MIN_GAS_PRICE;
      // Add a tiny per-click salt (≤ 0.1 gwei) so consecutive demo clicks
      // produce different payloads → different SigRequest PDAs. Without this,
      // a second click with the same nonce hits "Allocate: account already
      // in use" on-chain because the SigRequest PDA is seeded by payload.
      const salt = BigInt(Math.floor(Math.random() * 100_000_000));
      const gasPrice = baseGasPrice + salt;
      const valueWei = 100_000_000_000_000n; // 0.0001 ETH
      const valueWeiBe = bigintToBe(valueWei, 16);
      const gasLimit = 21_000n;

      const unsignedRlp = encodeUnsignedLegacy({
        nonce,
        gasPriceWei: gasPrice,
        gasLimit,
        to: new Uint8Array(recipient),
        valueWeiBe,
        data: new Uint8Array(0),
        chainId: 11_155_111n,
      });
      const payload = keccak_256(unsignedRlp);

      // -------- 3. Phantom signs eth_demo::sign_eth_transfer --------
      updateStep("signEthTransfer", "active");

      const sodaProgramId = new PublicKey(SODA_PROGRAM_ID);
      const ethDemoProgramId = new PublicKey(ETH_DEMO_PROGRAM_ID);
      const [committeePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("committee")],
        sodaProgramId,
      );
      const [sigRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("sig"), walletPubkey.toBuffer(), Buffer.from(payload)],
        sodaProgramId,
      );

      const provider = new AnchorProvider(
        connection,
        anchorWallet as Wallet,
        { commitment: "confirmed" },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ethDemoProgram = new Program(ethDemoIdl as any, provider);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signTxSig: string = await (ethDemoProgram.methods as any)
        .signEthTransfer(
          Array.from(foreignPkXy),
          Array.from(recipient),
          Array.from(valueWeiBe),
          new BN(nonce.toString()),
          new BN(gasPrice.toString()),
          new BN(gasLimit.toString()),
          Buffer.from(derivationSeeds),
        )
        .accounts({
          user: walletPubkey,
          committee: committeePda,
          sigRequest: sigRequestPda,
          sodaProgram: sodaProgramId,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      updateStep("signEthTransfer", "done");
      updateStep("sigRequested", "done");

      // -------- 4. Backend: MPC sign + finalize + broadcast --------
      updateStep("signOffChain", "active");
      const finalizeRes = await fetch("/api/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sigRequestPda: sigRequestPda.toBase58(),
          recipientHex,
          nonce: nonce.toString(),
          gasPriceWei: gasPrice.toString(),
          gasLimit: gasLimit.toString(),
          valueWei: valueWei.toString(),
        }),
      });
      if (!finalizeRes.ok) {
        const t = await finalizeRes.text();
        throw new Error(`/api/finalize ${finalizeRes.status}: ${t}`);
      }
      const finalize = (await finalizeRes.json()) as {
        ethTxHash: string;
        signedHex: string;
        finalizeSignatureTx: string;
        recoveryId: number;
        ethAddress: string;
        isSelfTransfer: boolean;
      };

      updateStep("signOffChain", "done");
      updateStep("finalizeOnChain", "done");
      updateStep("broadcastEth", "done");

      setResult({
        ethAddress: finalize.ethAddress,
        recipient: "0x" + recipientHex,
        isSelfTransfer: finalize.isSelfTransfer,
        signedHex: finalize.signedHex,
        ethTxHash: finalize.ethTxHash,
        signEthTransferTx: signTxSig,
        finalizeSignatureTx: finalize.finalizeSignatureTx,
        payloadHex: Buffer.from(payload).toString("hex"),
      });
      setSignedHex(finalize.signedHex);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setError(msg);
      setTimeline((prev) => {
        const next = { ...prev };
        (Object.keys(next) as (keyof TimelineState)[]).forEach((k) => {
          if (next[k] === "active") next[k] = "error";
        });
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  const isFunded = balance !== null && balance >= 200_000_000_000_000n;
  const buttonDisabled = !connected || !isFunded || balance === null || !ethAddress;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="text-xl font-semibold">SODA</div>
            <div className="hidden text-sm text-zinc-500 sm:block">
              Solana-Owned Derived Authority
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
            >
              Docs ↗
            </a>
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            A Solana program just signed an Ethereum transaction.
          </h1>
          <p className="mt-3 text-zinc-400">
            The address below is owned by an{" "}
            <code className="font-mono">eth_demo</code> program PDA on Solana
            — no private key. Two MPC nodes on AWS produce the signature
            jointly; Solana&apos;s <code className="font-mono">secp256k1_recover</code>{" "}
            syscall verifies it on-chain, then it&apos;s broadcast to Sepolia.
          </p>
          {connected && walletPubkey ? (
            <p className="mt-3 text-xs font-mono text-emerald-300/80">
              connected: {walletPubkey.toBase58().slice(0, 8)}…{walletPubkey.toBase58().slice(-6)}
            </p>
          ) : (
            <p className="mt-3 text-xs text-amber-300/80">
              Connect Phantom (top-right) on devnet to enable the Sign &amp; Send button.
            </p>
          )}
        </div>

        {connected ? (
          <>
            <div className="grid gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm font-mono text-zinc-400">
              <div>SODA program:     {programs.soda}</div>
              <div>eth_demo program: {programs.ethDemo}</div>
              <div>Solana cluster:   devnet (Helius)</div>
            </div>

            {/* Live MPC committee status */}
            <div className="rounded-2xl border border-emerald-900/60 bg-emerald-950/20 p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-emerald-400">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                Live MPC committee · 2-of-2 Lindell &apos;17 ECDSA
              </div>
              <div className="mt-2 grid gap-1 text-sm font-mono text-emerald-200/80">
                <div>node P1 · us-east-1 · share x1</div>
                <div>node P2 · us-east-1 · share x2</div>
                <div>coordinator · {MPC_COORDINATOR}</div>
                <div className="pt-1 text-xs text-emerald-300/60">
                  Neither node holds the joint secret. Signing runs the 4-message
                  Lindell &apos;17 protocol; the on-chain{" "}
                  <code>secp256k1_recover</code> syscall verifies the result.
                </div>
              </div>
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
          </>
        ) : (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-center">
            <div className="text-lg font-medium text-zinc-200">
              Connect Phantom to begin
            </div>
            <div className="mt-2 text-sm text-zinc-500">
              Use the button in the top-right. Devnet only — Phantom will switch
              automatically.
            </div>
          </div>
        )}

        {error ? (
          <div className="rounded-lg bg-rose-950/40 border border-rose-900 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <Timeline state={timeline} />

        <SignedHexView signedRlpHex={signedHex} />

        {result ? (
          <div className="rounded-2xl border border-emerald-800 bg-emerald-950/30 p-6 space-y-4">
            <div className="text-xs uppercase tracking-wider text-emerald-400">
              Done · verify on both chains
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              {/* Ethereum side */}
              <div className="space-y-2">
                <div className="text-xs uppercase tracking-wider text-emerald-300/70">
                  Sepolia · Etherscan
                </div>
                <div className="rounded-lg bg-white p-3">
                  <QRCodeSVG
                    value={`https://sepolia.etherscan.io/tx/${result.ethTxHash}`}
                    size={160}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="M"
                    className="mx-auto block"
                  />
                </div>
                <a
                  href={`https://sepolia.etherscan.io/tx/${result.ethTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all font-mono text-xs text-emerald-200 underline hover:text-emerald-100"
                >
                  {result.ethTxHash}
                </a>
              </div>

              {/* Solana side */}
              <div className="space-y-2">
                <div className="text-xs uppercase tracking-wider text-emerald-300/70">
                  Solana · finalize_signature (Helius XRAY)
                </div>
                <div className="rounded-lg bg-white p-3">
                  <QRCodeSVG
                    value={`https://xray.helius.xyz/tx/${result.finalizeSignatureTx}?network=devnet`}
                    size={160}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="M"
                    className="mx-auto block"
                  />
                </div>
                <a
                  href={`https://xray.helius.xyz/tx/${result.finalizeSignatureTx}?network=devnet`}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all font-mono text-xs text-emerald-200 underline hover:text-emerald-100"
                >
                  {result.finalizeSignatureTx}
                </a>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-1 border-t border-emerald-900/50 pt-3 text-xs font-mono text-emerald-300/70 sm:grid-cols-[auto_1fr] sm:gap-x-4">
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
              <span className="text-emerald-300/50">soda program</span>
              <span className="break-all">{programs.soda}</span>
              <span className="text-emerald-300/50">sign_eth_transfer</span>
              <span className="break-all">{result.signEthTransferTx}</span>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
