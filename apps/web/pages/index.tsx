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
  computeTweak,
  deriveForeignPk,
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

// Public Sepolia RPC defaults — used when NEXT_PUBLIC_SEPOLIA_RPC_URL isn't
// set (e.g. on Vercel before env vars are configured). PublicNode is free,
// no API key, decent rate limits. `rpc.sepolia.org` (the previous default)
// is unreliable and frequently rate-limits browser requests.
const SEPOLIA_RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ??
  "https://ethereum-sepolia.publicnode.com";
const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

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
    if (!groupPkHex || !walletPubkey) {
      setEthAddress(null);
      return;
    }
    // The address belongs to the CONNECTED WALLET, not to the committee.
    // soda::request_signature derives the same value on-chain from the signer,
    // so this is a local preview of what the program will compute — connect a
    // different wallet and you get a different address.
    const groupPk = Uint8Array.from(
      Buffer.from(groupPkHex.replace(/^0x/, ""), "hex"),
    );
    const tweak = computeTweak(
      walletPubkey.toBytes(),
      new Uint8Array(0),
      ETH_SEPOLIA_CHAIN_TAG,
    );
    const foreignPk = deriveForeignPk(groupPk, tweak);
    setEthAddress(bytesToHex(ethAddressFromPk(foreignPk)));
  }, [groupPkHex, walletPubkey]);

  useEffect(() => {
    if (!ethAddress) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const b = await sepolia.getBalance(ethAddress);
        if (!cancelled) setBalance(b);
      } catch (e) {
        // Log instead of swallowing — a stuck "—" balance with no console
        // signal makes Vercel misconfig invisible.
        // eslint-disable-next-line no-console
        console.warn("[soda] Sepolia balance fetch failed:", e);
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
      // -------- 1. Preview the derivation in the browser --------
      // The program derives foreign_pk itself from the signer, so nothing here
      // is authoritative — we compute it only to build the transaction and to
      // show the user which address will move. If this disagreed with the
      // program, finalize_signature would reject the signature.
      const groupPk = Uint8Array.from(
        Buffer.from(groupPkHex.replace(/^0x/, ""), "hex"),
      );
      const derivationSeeds = new Uint8Array(0); // path; empty = default account
      const tweak = computeTweak(
        walletPubkey.toBytes(),
        derivationSeeds,
        ETH_SEPOLIA_CHAIN_TAG,
      );
      const foreignPk = deriveForeignPk(groupPk, tweak);
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
    <div className="min-h-screen bg-surface text-primary">
      <header className="border-b border-subtle">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-5">
          <div className="flex items-baseline gap-3">
            <span className="text-base font-semibold tracking-tight">SODA</span>
            <span className="hidden text-sm text-secondary sm:inline">
              Solana-Owned Derived Authority
            </span>
          </div>
          <div className="flex items-center gap-5">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-secondary underline-offset-4 transition hover:text-primary hover:underline"
            >
              Docs
            </a>
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
        {/* The claim and the evidence for it share the first screen. */}
        <h1 className="max-w-2xl text-3xl leading-[1.15] font-semibold tracking-tight sm:text-4xl">
          Your Solana wallet controls an Ethereum address that has no private
          key.
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-secondary">
          The SODA program derives the address on-chain from the account that
          signs. Two MPC nodes hold separate shares and produce the signature
          jointly, then Solana&apos;s{" "}
          <code className="font-mono text-[0.9em] text-primary">
            secp256k1_recover
          </code>{" "}
          syscall verifies it before the transaction reaches Sepolia.
        </p>

        {connected ? (
          <>
            <div className="mt-14">
              <DerivedAddressCard
                ethAddress={ethAddress}
                sepoliaBalanceWei={balance}
                loading={!groupPkHex}
                derivedFrom={walletPubkey?.toBase58() ?? null}
              />
            </div>

            {/* The action sits with the evidence, not a screen below it. */}
            <div className="mt-12 border-t border-subtle pt-8">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor="recipient"
                    className="block text-sm text-secondary"
                  >
                    Recipient
                  </label>
                  <input
                    id="recipient"
                    type="text"
                    value={recipientInput}
                    onChange={(e) => setRecipientInput(e.target.value)}
                    placeholder={ethAddress ?? "0x…"}
                    disabled={busy}
                    className="mt-2 h-11 w-full rounded-md border border-default bg-surface px-3 font-mono text-sm text-primary placeholder:text-tertiary focus:border-strong focus:outline-none disabled:opacity-50"
                  />
                  <p className="mt-2 text-sm text-secondary">
                    Leave empty to send back to itself, which spends gas only.
                  </p>
                </div>
                <SignAndSendButton
                  disabled={buttonDisabled}
                  busy={busy}
                  onClick={onSign}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="mt-14 border-t border-subtle pt-8">
            <p className="text-base">Connect Phantom to run it yourself.</p>
            <p className="mt-2 max-w-xl text-sm text-secondary">
              Use the button above. Devnet only, and your wallet pays the Solana
              fee. Reading this page needs no wallet.
            </p>
          </div>
        )}

        {error ? (
          <div
            role="alert"
            className="mt-10 border-l-2 border-error bg-error-surface py-3 pl-4 pr-4"
          >
            <p className="text-sm font-medium text-error">Run failed</p>
            <p className="mt-1 font-mono text-sm break-all text-secondary">
              {error}
            </p>
          </div>
        ) : null}

        <div className="mt-16">
          <Timeline state={timeline} />
        </div>

        <SignedHexView signedRlpHex={signedHex} />

        {result ? (
          <section
            aria-labelledby="result"
            className="mt-16 border-t border-subtle pt-10"
          >
            <h2 id="result" className="text-xl font-semibold tracking-tight">
              Signed on Solana, settled on Ethereum
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-secondary">
              The same signature appears in both records below. Scan or open
              either to check it independently.
            </p>

            <dl className="mt-8 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[7rem_1fr]">
              <dt className="text-secondary">From</dt>
              <dd className="font-mono break-all">{result.ethAddress}</dd>
              <dt className="text-secondary">To</dt>
              <dd className="font-mono break-all">
                {result.recipient}
                {result.isSelfTransfer ? (
                  <span className="ml-2 font-sans text-secondary">
                    self-transfer
                  </span>
                ) : null}
              </dd>
              <dt className="text-secondary">Value</dt>
              <dd className="tabular font-mono">0.0001 ETH</dd>
              <dt className="text-secondary">sign_eth_transfer</dt>
              <dd className="font-mono break-all">{result.signEthTransferTx}</dd>
            </dl>

            <div className="mt-10 grid gap-10 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-medium">Ethereum · Etherscan</h3>
                <div className="mt-3 inline-block rounded-md bg-white p-3">
                  <QRCodeSVG
                    value={`https://sepolia.etherscan.io/tx/${result.ethTxHash}`}
                    size={140}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="M"
                    className="block"
                  />
                </div>
                <a
                  href={`https://sepolia.etherscan.io/tx/${result.ethTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 block font-mono text-sm break-all underline underline-offset-2 hover:text-secondary"
                >
                  {result.ethTxHash}
                </a>
              </div>

              <div>
                <h3 className="text-sm font-medium">
                  Solana · finalize_signature
                </h3>
                <div className="mt-3 inline-block rounded-md bg-white p-3">
                  <QRCodeSVG
                    value={`https://xray.helius.xyz/tx/${result.finalizeSignatureTx}?network=devnet`}
                    size={140}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="M"
                    className="block"
                  />
                </div>
                <a
                  href={`https://xray.helius.xyz/tx/${result.finalizeSignatureTx}?network=devnet`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 block font-mono text-sm break-all underline underline-offset-2 hover:text-secondary"
                >
                  {result.finalizeSignatureTx}
                </a>
              </div>
            </div>
          </section>
        ) : null}

        {/* Audit path. Deliberately quiet and last: it supports the claim
            above rather than competing with it for the first read. */}
        <section
          aria-labelledby="committee"
          className="mt-20 border-t border-subtle pt-10"
        >
          <h2 id="committee" className="text-sm font-medium">
            Committee and deployment
          </h2>
          <dl className="mt-6 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-secondary">Protocol</dt>
            <dd>2-of-2 Lindell &apos;17 threshold ECDSA</dd>
            <dt className="text-secondary">Node P1</dt>
            <dd className="font-mono">share x1</dd>
            <dt className="text-secondary">Node P2</dt>
            <dd className="font-mono">share x2</dd>
            <dt className="text-secondary">Coordinator</dt>
            <dd className="font-mono break-all">{MPC_COORDINATOR}</dd>
            <dt className="text-secondary">SODA program</dt>
            <dd className="font-mono break-all">{programs.soda}</dd>
            <dt className="text-secondary">eth_demo program</dt>
            <dd className="font-mono break-all">{programs.ethDemo}</dd>
            <dt className="text-secondary">Cluster</dt>
            <dd>Solana devnet</dd>
          </dl>
          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-secondary">
            Neither node ever sees the joint secret. Both currently run on one
            Render instance for this demo, so the two shares share a host;
            separating them across hosts is a configuration change, not a
            protocol change.
          </p>
        </section>
      </main>

      <footer className="border-t border-subtle">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-sm text-secondary">
          <span>SODA · Solana-Owned Derived Authority</span>
          <span>Devnet demo. Not audited.</span>
        </div>
      </footer>
    </div>
  );
}
