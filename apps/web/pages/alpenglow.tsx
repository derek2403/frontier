// /alpenglow — SODA with no MPC in the signing path. Testnet only.
//
// 1. The owner approves an action in a Memo transaction on Solana devnet,
//    which runs Alpenglow. The page times processed and finalized itself.
// 2. A relayer posts a finality certificate for that block to a light client
//    on Base Sepolia. The light client checks the BLS aggregate signature
//    and the 60% stake rule. The validator set is SIMULATED (see below).
// 3. The owner's SODA smart account checks that its approval is in the
//    certified block, then makes a real Aave V3 deposit.
//
// Two networks:
//   local   our own Alpenglow node on this laptop (solana-test-validator
//           --alpenglow + Yellowstone gRPC). Its certificates are REAL and
//           come from its block footers.
//   devnet  Solana devnet (also Alpenglow). No provider streams its
//           certificates yet, so the certificate is signed by simulated keys.
//
// The page uses its own Solana connections, so it works the same whether the
// rest of the site runs on mainnet or devnet.

import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { QRCodeSVG } from "qrcode.react";
import StepCard, { type StepState } from "@/components/StepCard";
import {
  ALPENGLOW,
  MEMO_PROGRAM_ID,
  NON_SIGNER_CHOICES,
  type AccountState,
  type CertifyResponse,
  type EvmTxReport,
  type ExecuteResponse,
  type PrepareResponse,
  type NetName,
} from "@/lib/alpenglow/shared";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

const DEVNET_RPC = process.env.NEXT_PUBLIC_ALPENGLOW_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const LOCAL_RPC = process.env.NEXT_PUBLIC_ALPENGLOW_LOCAL_RPC_URL || "http://127.0.0.1:8899";
const rpcFor = (net: NetName) => (net === "local" ? LOCAL_RPC : DEVNET_RPC);
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? "https://frontier-docs-cazz.vercel.app";

const baseTx = (h: string) => `https://sepolia.basescan.org/tx/${h}`;
const baseAddr = (a: string) => `https://sepolia.basescan.org/address/${a}`;
const solTx = (s: string, net: NetName) =>
  net === "local"
    ? `https://explorer.solana.com/tx/${s}?cluster=custom&customUrl=${encodeURIComponent(LOCAL_RPC)}`
    : `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const short = (s: string, n = 6) => (s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);
const eth = (wei: string | bigint, dp = 6) => (Number(BigInt(wei)) / 1e18).toFixed(dp);
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const fmt = (n: number) => n.toLocaleString("en-US");

type Finality = { processed?: number; confirmed?: number; finalized?: number };
const PHASE_LABEL: Record<string, string> = {
  preparing: "Preparing…",
  approving: "Signing on Solana…",
  finalizing: "Waiting for Alpenglow finality…",
  certifying: "Checking the certificate on Base…",
  executing: "Depositing into Aave…",
};
type Phase = "idle" | "preparing" | "approving" | "finalizing" | "certifying" | "executing" | "done";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/alpenglow/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

function memoIx(memo: string, owner: PublicKey) {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8"),
  });
}

/** Sends a signed transaction and records when each commitment level is reached. */
function sendAndTime(conn: Connection, raw: Buffer, onUpdate: (f: Finality) => void): Promise<string> {
  const sig = utils.bytes.bs58.encode(Transaction.from(raw).signature!);
  const seen: Finality = {};
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    // A signature subscription ends by itself once it fires; only the
    // levels that never fired need removing.
    const subs = new Map<keyof Finality, number>();
    let done = false;
    const mark = (level: keyof Finality) => {
      if (seen[level] != null) return;
      seen[level] = Math.round(performance.now() - t0);
      onUpdate({ ...seen });
      if (level === "finalized" && !done) {
        done = true;
        clearInterval(poll);
        subs.forEach((id) => conn.removeSignatureListener(id).catch(() => {}));
        resolve(sig);
      }
    };
    for (const level of ["processed", "confirmed", "finalized"] as const) {
      const id = conn.onSignature(
        sig,
        (r) => {
          subs.delete(level);
          if (r.err) reject(new Error("approval failed on devnet"));
          else mark(level);
        },
        level,
      );
      subs.set(level, id);
    }
    // WebSocket events are the precise timer; polling is the fallback.
    const poll = setInterval(async () => {
      if (performance.now() - t0 > 60_000) {
        clearInterval(poll);
        if (!done) reject(new Error("approval did not finalize within 60 s"));
        return;
      }
      const s = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value[0];
      if (s?.err) reject(new Error("approval failed on devnet"));
      if (s?.confirmationStatus === "finalized") mark("finalized");
      else if (s?.confirmationStatus) mark(s.confirmationStatus);
    }, 400);
    conn.sendRawTransaction(raw, { skipPreflight: true }).catch(reject);
  });
}

function useTicker(running: boolean, since: number | null) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running || since == null) return;
    const id = setInterval(() => setNow(performance.now() - since), 50);
    return () => clearInterval(id);
  }, [running, since]);
  return now;
}

function TxRow({ label, tx }: { label: string; tx: EvmTxReport }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
      <Stat k="Gas used" v={fmt(tx.gasUsed)} />
      <Stat k="Calldata" v={`${fmt(tx.calldataBytes)} bytes`} />
      <Stat k="Time on Base" v={secs(tx.ms)} />
      <Stat k="Testnet fee" v={`${eth(tx.feeWei, 8)} ETH`} />
      <a className="col-span-full mt-1 font-mono text-xs text-emerald-300 hover:underline" href={baseTx(tx.hash)} target="_blank" rel="noreferrer">
        {label}: {short(tx.hash, 10)} ↗
      </a>
    </div>
  );
}

function Stat({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{k}</div>
      <div className={["font-mono", strong ? "text-lg text-emerald-200" : "text-zinc-200"].join(" ")}>{v}</div>
    </div>
  );
}

type LocalStatus = { slot: number; version: string; certsSeen: number; lastError: string | null } | { error: string };

export default function AlpenglowPage() {
  const wallet = useWallet();
  const [net] = useState<NetName>("local");
  const conns = useRef<Partial<Record<NetName, Connection>>>({});
  const conn = () => (conns.current[net] ??= new Connection(rpcFor(net), "processed"));
  // Every API call names the network.
  const call = <T,>(path: string, body?: Record<string, unknown>) =>
    body === undefined
      ? api<T>(`${path}${path.includes("?") ? "&" : "?"}net=${net}`)
      : api<T>(path, { ...body, net });
  const [local, setLocal] = useState<LocalStatus | null>(null);

  const [demoOwner, setDemoOwner] = useState<string | null>(null);
  // The local node's own funded wallet; Phantom is rarely set to Localnet.
  // The owner is the connected Phantom wallet. A hidden backup for a live
  // demo: open the page with ?demo and the server's local key signs instead.
  const [useDemo, setUseDemo] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("demo")) setUseDemo(true);
  }, []);
  const owner = useDemo ? demoOwner : wallet.publicKey?.toBase58() ?? null;
  const ownerRef = useRef<string | null>(null);
  ownerRef.current = owner;
  const [airdropping, setAirdropping] = useState(false);

  const [state, setState] = useState<AccountState | null>(null);
  const [devnetSol, setDevnetSol] = useState<number | null>(null);
  const [nonSigners, setNonSigners] = useState<number>(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [howOpen, setHowOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [prep, setPrep] = useState<PrepareResponse | null>(null);
  const [approvalSig, setApprovalSig] = useState<string | null>(null);
  const [finality, setFinality] = useState<Finality>({});
  const [cert, setCert] = useState<CertifyResponse | null>(null);
  const [exec, setExec] = useState<ExecuteResponse | null>(null);
  const busy = phase !== "idle" && phase !== "done";
  const elapsed = useTicker(busy, startedAt);

  useEffect(() => {
    api<{ owner: string | null }>("demo-owner").then((r) => setDemoOwner(r.owner)).catch(() => {});
  }, []);

  // Our local node: is it up, and is its certificate stream flowing?
  useEffect(() => {
    let stop = false;
    const tick = () =>
      api<LocalStatus>("local-status")
        .catch((e: Error) => ({ error: e.message }))
        .then((s) => !stop && setLocal(s));
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);


  const refresh = useCallback(async () => {
    if (!owner) return setState(null);
    try {
      // Drop answers for an owner that is no longer selected: a slow lookup
      // for the previous key must not overwrite the current one.
      const s = await call<AccountState>(`state?owner=${owner}`);
      if (ownerRef.current !== owner) return;
      setState(s);
      const key = new PublicKey(owner);
      let lamports = await conn().getBalance(key);
      // Our local network has a free faucet: give the wallet SOL for fees.
      if (net === "local" && lamports < 10_000_000) {
        setAirdropping(true);
        const sig = await conn().requestAirdrop(key, 1_000_000_000);
        await conn().confirmTransaction(sig, "confirmed");
        lamports = await conn().getBalance(key);
        setAirdropping(false);
      }
      if (ownerRef.current !== owner) return;
      setDevnetSol(lamports / 1e9);
    } catch (e) {
      setAirdropping(false);
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, net]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run() {
    if (!owner) return;
    setError(null);
    setPrep(null);
    setApprovalSig(null);
    setFinality({});
    setCert(null);
    setExec(null);
    const t0 = performance.now();
    setStartedAt(t0);
    try {
      setPhase("preparing");
      const p = await call<PrepareResponse>("prepare", { owner });
      setPrep(p);

      setPhase("approving");
      let raw: Buffer;
      if (useDemo) {
        raw = Buffer.from((await call<{ tx: string }>("demo-sign", { memo: p.memo })).tx, "base64");
      } else {
        if (!wallet.publicKey || !wallet.signTransaction) throw new Error("connect Phantom first");
        const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(
          memoIx(p.memo, wallet.publicKey),
        );
        raw = (await wallet.signTransaction(tx)).serialize();
      }

      setPhase("finalizing");
      const sig = await sendAndTime(conn(), raw, setFinality);
      setApprovalSig(sig);

      setPhase("certifying");
      setCert(await call<CertifyResponse>("certify", { signature: sig, nonSigners }));

      setPhase("executing");
      setExec(await call<ExecuteResponse>("execute", { signature: sig }));
      setPhase("done");
      // The public Base RPC can answer from a node one block behind.
      void refresh();
      setTimeout(() => void refresh(), 3000);
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  const stepState = (n: number): StepState => {
    // Step 2 covers preparing → finalizing; step 3 is certifying; step 4 executing.
    const at = ["preparing", "approving", "finalizing", "certifying", "executing", "done"].indexOf(phase);
    if (n === 1) return owner ? "done" : "active";
    if (!owner) return "locked";
    const activeAt = { 2: 0, 3: 3, 4: 4 }[n]!;
    const doneAt = { 2: 3, 3: 4, 4: 5 }[n]!;
    if (at >= doneAt) return "done";
    if (n === 2 || at === activeAt) return "active";
    return "locked";
  };

  const isLocal = net === "local";
  const netLabel = isLocal ? "our local Alpenglow network" : "Solana devnet";
  const localUp = local != null && !("error" in local);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="text-xl font-semibold">SODA</div>
            <nav className="flex rounded-lg border border-zinc-800 p-0.5 text-sm">
              <Link href="/" className="rounded-md px-3 py-1 text-zinc-400 hover:text-zinc-100">
                MPC · live
              </Link>
              <span className="rounded-md bg-zinc-800 px-3 py-1 text-zinc-100">Alpenglow · testnet</span>
            </nav>
          </div>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            Docs ↗
          </a>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <main className="min-w-0 space-y-6">
            <div>
              {/* The page runs on our local Alpenglow node only. The devnet path
                  (simulated certificate) stays in the code; set `net` to "devnet"
                  to bring it back. Only a down node is worth a line here. */}
              {local && !localUp ? (
                <div className="mb-3 text-xs text-rose-300">
                  ● Local Alpenglow node not reachable on {LOCAL_RPC}. Start it with
                  research/alpenglow-sim/start-local-node.sh.
                </div>
              ) : null}
              <h1 className="text-3xl font-semibold tracking-tight">SODA with Alpenglow: no MPC in the path.</h1>
              <p className="mt-3 text-zinc-400">
                Your Solana wallet approves an action on Solana. A light client on Base checks Solana&apos;s own
                finality certificate. Then your SODA smart account on Base does the action. No signing committee
                holds a key. The only extra trust is Solana&apos;s validators, the same ones that secure Solana.
              </p>
            </div>

            {error ? (
              <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            ) : null}

            <StepCard n={1} title="Choose the owner (a Solana key)" state={stepState(1)}>
              <div className="flex flex-wrap items-center gap-3">
                {useDemo ? (
                  <span className="text-sm text-zinc-400">Demo key (opened with ?demo)</span>
                ) : (
                  <WalletMultiButton />
                )}
              </div>
              <p className="mt-3 text-xs text-zinc-500">
                {isLocal
                  ? "Set Phantom to our local network: Settings → Developer settings → Testnet mode → Solana Localnet. The page gives your wallet local SOL for the fee."
                  : "Phantom must be on Solana Devnet (Settings → Developer settings → Testnet mode) and hold a little devnet SOL for the fee (about 0.000005 SOL)."}
              </p>
              {owner && state ? (
                <div className="mt-4 grid gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 text-sm sm:grid-cols-2">
                  <Stat k="Owner (Solana)" v={short(owner)} />
                  <Stat k={isLocal ? "Local SOL" : "Devnet SOL"} v={airdropping ? "airdropping…" : devnetSol == null ? "…" : devnetSol.toFixed(4)} />
                  <div className="sm:col-span-2">
                    <div className="text-xs text-zinc-500">SODA account on Base Sepolia (CREATE2 from the owner)</div>
                    <a className="font-mono text-emerald-300 hover:underline" href={baseAddr(state.account)} target="_blank" rel="noreferrer">
                      {state.account} ↗
                    </a>
                  </div>
                  <Stat k="Account deployed" v={state.deployed ? `yes · nonce ${state.nonce}` : "not yet (first action deploys it)"} />
                  <Stat k="ETH · aWETH" v={`${eth(state.balanceWei)} · ${eth(state.aWethWei)}`} />
                </div>
              ) : null}
            </StepCard>

            <StepCard n={2} title="Deposit ETH into Aave V3" state={stepState(2)}>
              <p className="text-sm text-zinc-400">
                Supply 0.0001 ETH to Aave V3 from your SODA account on Base Sepolia. You sign once, on Solana.
                Nobody signs anything on Base.
              </p>
              {isLocal ? null : (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-zinc-500">Simulated validators not signing (of {fmt(ALPENGLOW.validators)}):</span>
                {NON_SIGNER_CHOICES.map((n) => (
                  <button
                    key={n}
                    disabled={busy}
                    onClick={() => setNonSigners(n)}
                    className={[
                      "rounded-md border px-3 py-1 font-mono",
                      nonSigners === n ? "border-emerald-600 bg-emerald-950/50 text-emerald-200" : "border-zinc-700 text-zinc-400",
                    ].join(" ")}
                  >
                    {n}
                  </button>
                ))}
              </div>
              )}
              <button
                disabled={!owner || busy || (isLocal && !localUp)}
                onClick={() => void run()}
                className="mt-4 w-full rounded-2xl bg-emerald-500 px-6 py-4 text-base font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
              >
                {busy
                  ? `${PHASE_LABEL[phase]} ${secs(elapsed)}`
                  : phase === "done"
                    ? "Deposit 0.0001 ETH again"
                    : "Deposit 0.0001 ETH"}
              </button>
              <details className="group mt-3" open={howOpen}>
                <summary
                  onClick={(e) => {
                    e.preventDefault();
                    setHowOpen((v) => !v);
                  }}
                  className="cursor-pointer list-none text-[11px] uppercase tracking-wider text-zinc-500 transition hover:text-zinc-300"
                >
                  <span className="inline-block w-3 transition group-open:rotate-90">›</span>
                  What this click does
                </summary>
                <div className="mt-3 space-y-3 text-sm text-zinc-400">
                  <ol className="list-decimal space-y-1 pl-5">
                    <li>
                      You sign one Solana transaction: an action request for another chain. It names the exact
                      action on Base Sepolia: deposit 0.0001 ETH from this SODA account into Aave&apos;s contract, with a
                      nonce and a 10-minute deadline. Solana stores the request; it moves no funds on Solana.
                    </li>
                    <li>{netLabel.charAt(0).toUpperCase() + netLabel.slice(1)} finalizes it with Alpenglow.</li>
                    <li>The finality certificate for that block goes to the light client on Base (step 3).</li>
                    <li>The SODA account checks your signed action request, then makes the deposit (step 4).</li>
                  </ol>
                  <p>
                    This is the only signature in the flow. The SODA account has no private key, so it acts only on
                    an action you signed on Solana.
                  </p>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-zinc-500">Your signed action request</div>
                    <div className="mt-1 break-all rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 font-mono text-[11px] text-zinc-300">
                      {prep?.memo ?? "Appears here after you click."}
                    </div>
                  </div>
                </div>
              </details>
              {prep?.funding ? (
                <p className="mt-2 text-xs text-zinc-500">
                  The relayer first sent the account 0.0005 ETH for deposits:{" "}
                  <a className="text-emerald-300 hover:underline" href={baseTx(prep.funding.hash)} target="_blank" rel="noreferrer">
                    {short(prep.funding.hash)} ↗
                  </a>
                </p>
              ) : null}
              {phase !== "idle" || approvalSig ? (
                <div className="mt-4 grid grid-cols-3 gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <Stat k="Processed" v={finality.processed != null ? secs(finality.processed) : "…"} />
                  <Stat k="Confirmed" v={finality.confirmed != null ? secs(finality.confirmed) : finality.finalized != null ? "same as final" : "…"} />
                  <Stat k="Finalized" v={finality.finalized != null ? secs(finality.finalized) : "…"} strong />
                  {approvalSig ? (
                    <a className="col-span-3 font-mono text-xs text-emerald-300 hover:underline" href={solTx(approvalSig, net)} target="_blank" rel="noreferrer">
                      Your signed transaction on {netLabel}: {short(approvalSig, 10)} ↗
                    </a>
                  ) : null}
                </div>
              ) : null}
            </StepCard>

            <StepCard
              n={3}
              title={isLocal ? "Real Alpenglow certificate checked on Base" : "Certificate checked by the light client on Base"}
              state={stepState(3)}
            >
              {isLocal ? (
                <p className="text-sm text-zinc-400">
                  Our node&apos;s next block footer carries the finality certificate for your block. The relayer sends
                  it unchanged to <span className="font-mono">AlpenglowLightClient</span>, which rebuilds Agave&apos;s
                  signed bytes, reads the signer bitmap, checks the stake rule (80% fast, 60% slow) and checks the
                  BLS12-381 signature.
                </p>
              ) : (
                <p className="text-sm text-zinc-400">
                  The relayer sends the block&apos;s finality certificate to <span className="font-mono">SolanaLightClient</span>.
                  The contract subtracts the validators that did not sign, checks the stake is at least{" "}
                  {ALPENGLOW.thresholdPct}%, and checks one BLS12-381 pairing.
                </p>
              )}
              {cert ? (
                <div className="mt-4 space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <Stat k="Solana slot" v={fmt(cert.slot)} />
                    <Stat k={cert.real ? "Block ID" : "Blockhash"} v={cert.real ? short(cert.blockId, 6) : short(cert.blockhash, 4)} />
                    <Stat k="Signed stake" v={`${cert.signedStakePct}%`} />
                    <Stat k={cert.real ? "Validators" : "Not signing"} v={cert.real ? fmt(cert.validators) : `${cert.nonSigners} / ${fmt(cert.validators)}`} />
                  </div>
                  {cert.real ? (
                    <div className="space-y-1 rounded-lg border border-zinc-800 p-3 font-mono text-xs text-zinc-400">
                      <div>
                        <span className="text-zinc-500">finality </span>
                        <span className="text-zinc-200">{cert.real.kind}</span>
                      </div>
                      <div className="break-all">
                        <span className="text-zinc-500">signed bytes </span>
                        {cert.real.payload}
                      </div>
                      <div className="break-all">
                        <span className="text-zinc-500">BLS signature </span>
                        {short(cert.real.signature, 16)}
                      </div>
                      <div>
                        <span className="text-zinc-500">signer bitmap </span>
                        {cert.real.bitmap} <span className="text-zinc-500">· shred version </span>
                        {cert.real.shredVersion}
                      </div>
                    </div>
                  ) : null}
                  <TxRow label="Certificate tx" tx={cert.tx} />
                  {cert.real ? (
                    <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3">
                      <div className="mb-2 text-xs text-amber-200">
                        Not proved: the attester says your action request is in this block. The inclusion proof does not
                        exist yet.
                      </div>
                      <TxRow label="Attest tx" tx={cert.real.attest} />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </StepCard>

            <StepCard n={4} title="The SODA account deposits into Aave V3" state={stepState(4)}>
              <p className="text-sm text-zinc-400">
                The account checks that your action request is inside the certified block, checks the nonce and deadline,
                then calls Aave. The relayer pays gas but cannot change the action.
              </p>
              {exec ? (
                <div className="mt-4 space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Stat k="Account" v={exec.deployedNow ? "deployed in this tx" : "already deployed"} />
                    <Stat k="aWETH held" v={eth(exec.aWethWei)} />
                  </div>
                  <TxRow label="Aave deposit tx" tx={exec.tx} />
                </div>
              ) : null}
              {exec && cert ? (
                <div className="mt-4 space-y-4 rounded-2xl border border-emerald-800 bg-emerald-950/30 p-6">
                  <div className="text-xs uppercase tracking-wider text-emerald-400">Done · verify on Base Sepolia</div>
                  <div className="grid gap-6 sm:grid-cols-2">
                    {(
                      [
                        ["Aave deposit · BaseScan", exec.tx.hash],
                        ["Certificate check · BaseScan", cert.tx.hash],
                      ] as const
                    ).map(([label, hash]) => (
                      <div key={hash} className="min-w-0 space-y-2">
                        <div className="text-xs uppercase tracking-wider text-emerald-300/70">{label}</div>
                        <div className="rounded-lg bg-white p-3">
                          <QRCodeSVG value={baseTx(hash)} size={160} bgColor="#ffffff" fgColor="#000000" level="M" className="mx-auto block" />
                        </div>
                        <a
                          href={baseTx(hash)}
                          target="_blank"
                          rel="noreferrer"
                          className="block break-all font-mono text-xs text-emerald-200 underline hover:text-emerald-100"
                        >
                          {hash}
                        </a>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 gap-1 border-t border-emerald-900/50 pt-3 font-mono text-xs text-emerald-300/70 sm:grid-cols-[auto_1fr] sm:gap-x-4">
                    <span className="text-emerald-300/50">from</span>
                    <span className="break-all">{exec.account} (SODA account of your Solana key)</span>
                    <span className="text-emerald-300/50">action</span>
                    <span>deposit 0.0001 ETH into Aave V3</span>
                    <span className="text-emerald-300/50">proof</span>
                    <span className="break-all">real Alpenglow certificate for slot {fmt(cert.slot)}</span>
                  </div>
                </div>
              ) : null}
            </StepCard>
          </main>

        </div>
      </div>
    </div>
  );
}
