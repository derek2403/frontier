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
  AAVE_BORROW_AMOUNT_USDC,
  AAVE_BORROW_GAS_LIMIT,
  AAVE_BORROW_MIN_BALANCE_WEI,
  AAVE_DEPOSIT_GAS_LIMIT,
  AAVE_DEPOSIT_MIN_BALANCE_WEI,
  type AaveUserAccountData,
  type AaveV3Addresses,
  addressToBytes,
  borrowCalldata,
  decodeReserveRates,
  decodeUserAccountData,
  depositEthCalldata,
  erc20BalanceOfCalldata,
  getChain,
  getReserveDataCalldata,
  getUserAccountDataCalldata,
  rayRateToApr,
  rayRateToApy,
  bigintToBe,
  computeTweak,
  deriveForeignPk,
  encodeUnsignedLegacy,
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

// The signing backend is reported by /api/group-pk from the SERVER's env, not
// read from a NEXT_PUBLIC_* copy. The copy drifted: a deployment kept
// advertising a coordinator host that had been decommissioned for months.
type SignerInfo =
  | { mode: "mpc"; coordinator: string }
  | { mode: "dev-key"; source: "env" | "file" | "missing" };

const DOCS_URL =
  process.env.NEXT_PUBLIC_DOCS_URL ?? "https://frontier-docs-cazz.vercel.app";

const INITIAL_TIMELINE: TimelineState = {
  signEthTransfer: "idle",
  sigRequested: "idle",
  signOffChain: "idle",
  finalizeOnChain: "idle",
  broadcastEth: "idle",
};

// Destination chain, chosen at build time by NEXT_PUBLIC_DEMO_CHAIN
// (sepolia | base-sepolia) to mirror the CLI's DEMO_CHAIN.
const CHAIN = getChain(process.env.NEXT_PUBLIC_DEMO_CHAIN);

// Both env vars are referenced statically because Next only inlines
// NEXT_PUBLIC_* names it can see literally — a dynamic process.env[key]
// lookup is always undefined in the browser bundle.
const EVM_RPC =
  (CHAIN.key === "base-sepolia"
    ? process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
    : process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL) ?? CHAIN.defaultRpc;
const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((n) => n.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Actions. Every action is the same pipeline — Phantom signs sign_eth_transfer,
// the committee signs the payload, finalize_signature verifies it on-chain,
// the relayer broadcasts — with a different EVM transaction at the end. This
// table is the ONLY place that differs per action, so adding one is a row.
// ---------------------------------------------------------------------------
type ActionKey = "deposit" | "borrow";

type TxSpec = {
  to: Uint8Array;
  valueWei: bigint;
  data: Uint8Array;
  gasLimit: bigint;
  /** What the derived address must hold before this can be broadcast. */
  minBalanceWei: bigint;
};

type ActionDef = {
  key: ActionKey;
  title: string;
  /** The contract call, for the card. */
  callName: string;
  /** Button text before / after a successful run. */
  button: string;
  buttonAgain: string;
  description: string;
  /** Label for the `to` address in the result panel. */
  toLabel: string;
  /** One-line result summary. */
  valueLine: string;
  build: (aave: AaveV3Addresses, derived: Uint8Array) => TxSpec;
};

const USDC_PER_CLICK = `${(Number(AAVE_BORROW_AMOUNT_USDC) / 1e6).toFixed(2)} USDC`;

const ACTIONS: Record<ActionKey, ActionDef> = {
  deposit: {
    key: "deposit",
    title: "Deposit ETH",
    callName: "WrappedTokenGatewayV3.depositETH",
    button: "Sign & deposit 0.0001 ETH into Aave V3",
    buttonAgain: "Deposit again",
    description:
      "Supplies 0.0001 ETH. The derived address receives aWETH — a lending " +
      "position held by a Solana account, earning interest from the next block.",
    toLabel: "Aave WrappedTokenGatewayV3",
    valueLine: "0.0001 ETH deposited → aWETH",
    build: (aave, derived) => ({
      // `to` is the gateway; `onBehalfOf` inside the calldata is the DERIVED
      // address, so the resulting aWETH is held by the Solana-controlled
      // account — not by the sponsor, not by the user's Phantom wallet.
      to: addressToBytes(aave.WETH_GATEWAY),
      valueWei: 100_000_000_000_000n, // 0.0001 ETH
      data: depositEthCalldata(aave, derived),
      gasLimit: AAVE_DEPOSIT_GAS_LIMIT,
      minBalanceWei: AAVE_DEPOSIT_MIN_BALANCE_WEI,
    }),
  },
  borrow: {
    key: "borrow",
    title: "Borrow USDC",
    callName: "Pool.borrow",
    button: `Sign & borrow ${USDC_PER_CLICK} against the ETH`,
    buttonAgain: "Borrow again",
    description:
      `Borrows ${USDC_PER_CLICK} at the variable rate against the aWETH ` +
      "collateral. Only the position's owner can do this, and the derived " +
      "address ends up holding an asset it never had.",
    toLabel: "Aave V3 Pool",
    valueLine: `${USDC_PER_CLICK} borrowed → USDC at the derived address`,
    build: (aave, derived) => ({
      to: addressToBytes(aave.POOL),
      valueWei: 0n,
      data: borrowCalldata(aave, AAVE_BORROW_AMOUNT_USDC, derived),
      gasLimit: AAVE_BORROW_GAS_LIMIT,
      minBalanceWei: AAVE_BORROW_MIN_BALANCE_WEI,
    }),
  },
};

/** Live view of the derived address inside Aave, straight from the Pool. */
type AavePosition = {
  aWethWei: bigint;
  usdcUnits: bigint;
  debtUsdcUnits: bigint;
  account: AaveUserAccountData;
  supplyApy: number;
  borrowApr: number;
};

const MAX_UINT256 = (1n << 256n) - 1n;

function fmtUsd8(v: bigint): string {
  return `$${(Number(v) / 1e8).toFixed(4)}`;
}
function fmtUsdc(v: bigint): string {
  return `${(Number(v) / 1e6).toFixed(4)} USDC`;
}
function fmtEth18(v: bigint, unit: string): string {
  return `${(Number(v) / 1e18).toFixed(9)} ${unit}`;
}

// A step is `locked` until the one before it produced its artifact. Locking is
// visual + pointer-events only; the underlying buttons are separately disabled,
// so a stray click can never skip ahead.
type StepState = "locked" | "active" | "done";

function StepCard({
  n,
  title,
  state,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  children: React.ReactNode;
}) {
  const locked = state === "locked";
  return (
    <section
      aria-current={state === "active" ? "step" : undefined}
      className={[
        "rounded-2xl border p-5 transition",
        state === "active"
          ? "border-emerald-700/70 bg-zinc-900/60"
          : state === "done"
            ? "border-zinc-800 bg-zinc-900/30"
            : "border-zinc-900 bg-zinc-900/10",
        locked ? "pointer-events-none select-none opacity-40" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-3">
        <span
          className={[
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            state === "done"
              ? "bg-emerald-500 text-emerald-950"
              : state === "active"
                ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/60"
                : "bg-zinc-800 text-zinc-500",
          ].join(" ")}
        >
          {state === "done" ? "✓" : n}
        </span>
        <h2
          className={[
            "text-sm font-medium",
            state === "locked" ? "text-zinc-500" : "text-zinc-100",
          ].join(" ")}
        >
          {title}
        </h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

type RunResult = {
  action: ActionKey;
  ethAddress: string;
  recipient: string;
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
  // Set when the server's chain differs from the one this bundle was built
  // for. Blocks the demo: proceeding would fund on one chain and broadcast
  // on another.
  const [configError, setConfigError] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [position, setPosition] = useState<AavePosition | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  // Which action is running, so the right button shows the spinner.
  const [running, setRunning] = useState<ActionKey | null>(null);

  const { publicKey: walletPubkey, connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const sepolia = useMemo(() => new EthRpc(EVM_RPC), []);

  useEffect(() => {
    fetch("/api/group-pk")
      .then((r) => r.json())
      .then(
        (d: {
          groupPkHex?: string;
          chain?: string;
          signer?: SignerInfo;
          payer?: "env" | "file" | "missing";
          error?: string;
        }) => {
          if (d.groupPkHex) setGroupPkHex(d.groupPkHex);
          else if (d.error) setError(d.error);
          if (d.chain && d.chain !== CHAIN.key) {
            setConfigError(
              `This page was built for ${CHAIN.name} (NEXT_PUBLIC_DEMO_CHAIN=` +
                `${CHAIN.key}) but the server is configured for "${d.chain}". ` +
                `Set both to the same chain and redeploy.`,
            );
          } else if (
            d.signer?.mode === "dev-key" &&
            d.signer.source === "missing"
          ) {
            setConfigError(
              "The server has no signer key: neither SODA_SIGNER_KEY_HEX nor " +
                "keyshare.dev.json is present, so /api/finalize cannot sign. " +
                "On Vercel, set SODA_SIGNER_KEY_HEX to the committee's key.",
            );
          } else if (d.payer === "missing") {
            setConfigError(
              "The server has no Solana wallet to pay for finalize_signature: " +
                "neither ANCHOR_WALLET_JSON nor a keypair file is present. On " +
                "Vercel, set ANCHOR_WALLET_JSON to the contents of " +
                "~/.config/solana/id.json (the 64-number array), then redeploy.",
            );
          }
        },
      )
      .catch((e) => setError(`Could not load dev signer key: ${(e as Error).message}`));
  }, []);

  // Derivation is deliberately NOT automatic. Each step of the demo is one
  // button, so the audience sees the address appear as a distinct act rather
  // than as page furniture that was already there on load.
  //
  // Changing wallet resets everything: the address is a function of the owner,
  // so a stale one from the previous wallet would be actively misleading.
  useEffect(() => {
    setEthAddress(null);
    setBalance(null);
    setBalanceError(null);
    setPosition(null);
    setPositionError(null);
    setResult(null);
    setSignedHex(null);
    setTimeline(INITIAL_TIMELINE);
    setError(null);
  }, [walletPubkey]);

  const onDerive = () => {
    if (!groupPkHex || !walletPubkey) {
      setError("committee key not loaded yet");
      return;
    }
    setError(null);
    try {
      // The address belongs to the CONNECTED WALLET, not to the committee.
      // soda::request_signature derives the same value on-chain from the
      // signer, so this is a preview of what the program will compute —
      // connect a different wallet and you get a different address.
      const groupPk = Uint8Array.from(
        Buffer.from(groupPkHex.replace(/^0x/, ""), "hex"),
      );
      const tweak = computeTweak(
        walletPubkey.toBytes(),
        new Uint8Array(0),
        CHAIN.chainTag,
      );
      const foreignPk = deriveForeignPk(groupPk, tweak);
      setEthAddress(bytesToHex(ethAddressFromPk(foreignPk)));
    } catch (e) {
      setError(`derivation failed: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    if (!ethAddress) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const b = await sepolia.getBalance(ethAddress);
        if (!cancelled) {
          setBalance(b);
          setBalanceError(null);
        }
      } catch (e) {
        // Show it on the card. A stuck "—" with the reason only in the
        // console made an RPC misconfiguration look like a derivation bug.
        // eslint-disable-next-line no-console
        console.warn("[soda] balance fetch failed:", e);
        if (!cancelled) {
          let host = EVM_RPC;
          try {
            host = new URL(EVM_RPC).host;
          } catch {
            /* keep raw */
          }
          setBalanceError(`${host}: ${(e as Error).message}`);
        }
      }
    };
    tick();
    const id = setInterval(tick, 8_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ethAddress, sepolia]);

  // The Aave position, read from the Pool itself rather than computed here,
  // so the numbers on screen are Aave's: what it counts as collateral, what
  // it would lend, the rate it pays. Polled so a deposit or borrow shows up
  // without a reload and the interest column visibly ticks.
  useEffect(() => {
    if (!ethAddress || !CHAIN.aave) return;
    const aave = CHAIN.aave;
    const derived = addressToBytes(ethAddress);
    let cancelled = false;
    const tick = async () => {
      try {
        const [aWeth, usdc, debt, acct, wethRes, usdcRes] = await Promise.all([
          sepolia.ethCall(aave.A_WETH, erc20BalanceOfCalldata(derived)),
          sepolia.ethCall(aave.USDC_UNDERLYING, erc20BalanceOfCalldata(derived)),
          sepolia.ethCall(aave.V_USDC, erc20BalanceOfCalldata(derived)),
          sepolia.ethCall(aave.POOL, getUserAccountDataCalldata(derived)),
          sepolia.ethCall(aave.POOL, getReserveDataCalldata(aave.WETH_UNDERLYING)),
          sepolia.ethCall(aave.POOL, getReserveDataCalldata(aave.USDC_UNDERLYING)),
        ]);
        if (cancelled) return;
        setPosition({
          aWethWei: BigInt(aWeth),
          usdcUnits: BigInt(usdc),
          debtUsdcUnits: BigInt(debt),
          account: decodeUserAccountData(acct),
          supplyApy: rayRateToApy(decodeReserveRates(wethRes).currentLiquidityRate),
          borrowApr: rayRateToApr(decodeReserveRates(usdcRes).currentVariableBorrowRate),
        });
        setPositionError(null);
      } catch (e) {
        if (!cancelled) setPositionError((e as Error).message);
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

  const runAction = async (action: ActionKey) => {
    if (busy) return;
    const def = ACTIONS[action];
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
    setRunning(action);

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
        CHAIN.chainTag,
      );
      const foreignPk = deriveForeignPk(groupPk, tweak);
      const ethAddrBytes = ethAddressFromPk(foreignPk);

      // -------- 2. Build the unsigned tx --------
      if (!CHAIN.aave) {
        throw new Error(`${CHAIN.name} has no Aave V3 deployment configured`);
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
      const spec = def.build(CHAIN.aave, ethAddrBytes);
      const valueWei = spec.valueWei;
      const valueWeiBe = bigintToBe(valueWei, 16);
      const txTo = spec.to;
      const txData = spec.data;
      const gasLimit = spec.gasLimit;

      const unsignedRlp = encodeUnsignedLegacy({
        nonce,
        gasPriceWei: gasPrice,
        gasLimit,
        to: txTo,
        valueWeiBe,
        data: txData,
        chainId: CHAIN.chainId,
      });
      const payload = keccak_256(unsignedRlp);

      // -------- 3. Encode the Solana instruction --------
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
      const signBuilder = (ethDemoProgram.methods as any)
        .signEthTransfer(
          Array.from(txTo),
          Array.from(valueWeiBe),
          new BN(nonce.toString()),
          new BN(gasPrice.toString()),
          new BN(gasLimit.toString()),
          Buffer.from(txData),
          new BN(CHAIN.chainId.toString()),
          Array.from(CHAIN.chainTag),
          Buffer.from(derivationSeeds),
        )
        .accounts({
          user: walletPubkey,
          committee: committeePda,
          sigRequest: sigRequestPda,
          sodaProgram: sodaProgramId,
          systemProgram: SystemProgram.programId,
        });
      // Encode now, before anything is spent. A committed web IDL that has
      // drifted from the program fails here with "provided too many
      // arguments"; this used to run after the sponsor top-up, so every click
      // on a stale build cost up to 0.002 ETH and still went nowhere.
      await signBuilder.instruction();

      // -------- 4. Fund the derived address --------
      // Gas is paid by the tx's `from`, so this address needs ETH of its own.
      // /api/fund is idempotent and returns immediately if already funded; it
      // runs inside `busy` because confirmation can take a minute or two. The
      // Aave call needs ~300k gas of headroom, well past a 21k transfer.
      const requiredWei = spec.minBalanceWei;
      if (balance === null || balance < requiredWei) {
        const fundRes = await fetch("/api/fund", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chain: CHAIN.key,
            address: ethAddress,
            minWei: requiredWei.toString(),
          }),
        });
        const fundJson = (await fundRes.json()) as {
          funded?: boolean;
          balanceWei?: string;
          error?: string;
        };
        if (!fundRes.ok || !fundJson.funded) {
          throw new Error(
            fundJson.error ?? "could not fund the derived address",
          );
        }
        if (fundJson.balanceWei) setBalance(BigInt(fundJson.balanceWei));
      }

      // -------- 5. Ask the EVM node to simulate it --------
      // Aave refusing (no collateral, borrow cap, paused reserve) is a revert
      // inside the transaction, which would otherwise be discovered only after
      // Phantom signed, the committee signed, and gas was burned on-chain.
      // eth_estimateGas runs the call and surfaces the revert reason now.
      try {
        await sepolia.estimateGas({
          from: ethAddress,
          to: bytesToHex(txTo),
          data: txData,
          valueWei,
        });
      } catch (e) {
        throw new Error(
          `${def.callName} would revert for ${ethAddress}: ${(e as Error).message}`,
        );
      }

      // -------- 6. Phantom signs eth_demo::sign_eth_transfer --------
      updateStep("signEthTransfer", "active");
      const signTxSig: string = await signBuilder.rpc();

      updateStep("signEthTransfer", "done");
      updateStep("sigRequested", "done");

      // -------- 7. Backend: MPC sign + finalize + broadcast --------
      updateStep("signOffChain", "active");
      const finalizeRes = await fetch("/api/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chain: CHAIN.key,
          sigRequestPda: sigRequestPda.toBase58(),
          // `to` and `data` must be exactly what was committed on-chain;
          // /api/finalize re-encodes and refuses on a payload mismatch.
          recipientHex: bytesToHex(txTo),
          dataHex: bytesToHex(txData),
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
      };

      updateStep("signOffChain", "done");
      updateStep("finalizeOnChain", "done");
      updateStep("broadcastEth", "done");

      setResult({
        action,
        ethAddress: finalize.ethAddress,
        recipient: bytesToHex(txTo),
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
      setRunning(null);
    }
  };

  // Funding is not a gate: an unfunded address is topped up from the sponsor
  // key on click. Blocking on balance just produced a dead button whenever the
  // derivation changed, since every new owner starts at zero.
  const buttonDisabled = !connected || !ethAddress || !!configError;

  // Three explicit steps. Each is complete only when its own artifact exists,
  // so the stepper reflects real state rather than a counter we increment.
  const step1Done = connected && !!walletPubkey;
  const step2Done = !!ethAddress;
  const step3Done = !!result;
  const activeStep = !step1Done ? 1 : !step2Done ? 2 : 3;

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
          {/* The wallet button lives in step 1 only. A second copy up here
              made "connect" look like page chrome rather than the first act. */}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
          >
            Docs ↗
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Lend and borrow on Aave with nothing but a Solana wallet.
          </h1>
          <p className="mt-3 text-zinc-400">
            Your Solana wallet owns an address on {CHAIN.name}. Deposit ETH into
            Aave V3 and borrow USDC against it, one Phantom approval each. No
            bridge, no ETH to hold, no second wallet. A Solana program commits
            the exact transaction and verifies the signature on-chain before
            anything is broadcast.
          </p>
        </div>

        {configError ? (
          <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            <div className="font-medium">Deployment misconfigured</div>
            <div className="mt-1 text-rose-200/80">{configError}</div>
          </div>
        ) : null}

        {/* Every step renders always. A locked step stays visible and dimmed so
            the audience can see the whole path up front instead of watching
            cards appear one at a time. */}
        <div className="space-y-4">
          {/* ---------- STEP 1 · connect ---------- */}
            <StepCard
              n={1}
              title="Connect your Solana wallet"
              state={step1Done ? "done" : "active"}
            >
              {step1Done && walletPubkey ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="font-mono text-sm text-emerald-200">
                    {walletPubkey.toBase58()}
                  </div>
                  <WalletMultiButton />
                </div>
              ) : (
                <>
                  <p className="text-sm text-zinc-400">
                    Phantom on devnet. This wallet is the <em>owner</em> — the
                    Ethereum address in the next step is derived from its public
                    key, and only it can request a signature for that address.
                  </p>
                  <div className="mt-4">
                    <WalletMultiButton />
                  </div>
                </>
              )}
            </StepCard>

            {/* ---------- STEP 2 · derive ---------- */}
            <StepCard
              n={2}
              title="Derive your Ethereum address"
              state={step2Done ? "done" : activeStep === 2 ? "active" : "locked"}
            >
              {step2Done ? (
                <>
                  <DerivedAddressCard
                    ethAddress={ethAddress}
                    sepoliaBalanceWei={balance}
                    loading={false}
                    balanceError={balanceError}
                  />
                  <p className="mt-3 text-xs text-zinc-500">
                    This is a pure function of your wallet:{" "}
                    <code className="font-mono">group_pk + tweak·G</code> where{" "}
                    <code className="font-mono">
                      tweak = sha256(domain ‖ your&nbsp;pubkey ‖ path ‖ chain)
                    </code>
                    . No registry, nothing stored — connect a different wallet
                    and you get a different address.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-zinc-400">
                    Compute the {CHAIN.name} address that your Solana wallet
                    owns. The <code className="font-mono">soda</code> program
                    derives the same value on-chain from whoever signs, so the
                    caller can never name an address it does not control.
                  </p>
                  <button
                    type="button"
                    disabled={!groupPkHex || !!configError}
                    onClick={onDerive}
                    className="mt-4 w-full rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
                  >
                    {groupPkHex ? "Derive address" : "Loading committee key…"}
                  </button>
                </>
              )}
            </StepCard>

            {/* ---------- STEP 3 · transact ---------- */}
            <StepCard
              n={3}
              title={`Use Aave V3 on ${CHAIN.name}`}
              state={step3Done ? "done" : activeStep === 3 ? "active" : "locked"}
            >
              <p className="text-xs text-zinc-500">
                Each button is one Phantom approval. The Solana program commits
                the exact EVM transaction, the committee signs it, and{" "}
                <code className="font-mono">secp256k1_recover</code> checks the
                signature on-chain before it is broadcast. Gas is topped up
                automatically from the sponsor key.
              </p>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {(Object.values(ACTIONS) as ActionDef[]).map((def) => {
                  const done = result?.action === def.key;
                  const needsCollateral =
                    def.key === "borrow" &&
                    position !== null &&
                    position.account.availableBorrowsBase === 0n;
                  return (
                    <div
                      key={def.key}
                      className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/40 p-4"
                    >
                      <div className="text-sm font-medium text-zinc-100">
                        {def.title}
                      </div>
                      <div className="mt-1 font-mono text-xs text-emerald-200">
                        Aave V3 · {def.callName}
                      </div>
                      <p className="mt-2 flex-1 text-xs text-zinc-500">
                        {def.description}
                      </p>
                      {needsCollateral ? (
                        <p className="mt-2 text-xs text-amber-300/80">
                          Aave reports nothing to borrow against yet — deposit
                          first.
                        </p>
                      ) : null}
                      <div className="mt-4">
                        <SignAndSendButton
                          disabled={buttonDisabled || (busy && running !== def.key)}
                          busy={running === def.key}
                          label={done ? def.buttonAgain : def.button}
                          onClick={() => runAction(def.key)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </StepCard>
        </div>

        {/* Aave's own view of the derived address. Nothing here is computed
            by us: every number is an eth_call to the Pool or a token, so what
            the audience sees is what Aave believes about a Solana wallet. */}
        {ethAddress && CHAIN.aave ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                Aave V3 position · live from the Pool on {CHAIN.name}
              </div>
              <div className="text-xs text-zinc-600">
                refreshes every 8s
              </div>
            </div>
            {position ? (
              <div className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs text-zinc-500">Supplied (aWETH)</div>
                  <div className="mt-0.5 font-mono text-emerald-200">
                    {fmtEth18(position.aWethWei, "aWETH")}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    earning {(position.supplyApy * 100).toFixed(2)}% APY
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500">Borrowed (USDC debt)</div>
                  <div className="mt-0.5 font-mono text-emerald-200">
                    {fmtUsdc(position.debtUsdcUnits)}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    at {(position.borrowApr * 100).toFixed(2)}% variable APR
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500">USDC held by the address</div>
                  <div className="mt-0.5 font-mono text-zinc-200">
                    {fmtUsdc(position.usdcUnits)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500">Collateral · available to borrow</div>
                  <div className="mt-0.5 font-mono text-zinc-200">
                    {fmtUsd8(position.account.totalCollateralBase)} ·{" "}
                    {fmtUsd8(position.account.availableBorrowsBase)}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    LTV {(Number(position.account.ltv) / 100).toFixed(2)}% · health
                    factor{" "}
                    {position.account.healthFactor === MAX_UINT256
                      ? "∞ (no debt)"
                      : (Number(position.account.healthFactor) / 1e18).toFixed(2)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-3 text-sm text-zinc-500">
                {positionError ? `could not read the Pool: ${positionError}` : "reading…"}
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              <a
                href={CHAIN.explorerToken(CHAIN.aave.A_WETH, ethAddress)}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-zinc-300"
              >
                aWETH on explorer →
              </a>
              <a
                href={CHAIN.explorerToken(CHAIN.aave.USDC_UNDERLYING, ethAddress)}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-zinc-300"
              >
                USDC on explorer →
              </a>
              <a
                href={CHAIN.explorerAddress(CHAIN.aave.POOL)}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-zinc-300"
              >
                Pool contract →
              </a>
            </div>
          </div>
        ) : null}

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
                  {CHAIN.name} · explorer
                </div>
                <div className="rounded-lg bg-white p-3">
                  <QRCodeSVG
                    value={CHAIN.explorerTx(result.ethTxHash)}
                    size={160}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="M"
                    className="mx-auto block"
                  />
                </div>
                <a
                  href={CHAIN.explorerTx(result.ethTxHash)}
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
                {result.ethAddress} (derived from your Solana wallet)
              </span>
              <span className="text-emerald-300/50">to</span>
              <span className="break-all">
                {result.recipient} ({ACTIONS[result.action].toLabel})
              </span>
              <span className="text-emerald-300/50">action</span>
              <span>{ACTIONS[result.action].valueLine}</span>
              <span className="text-emerald-300/50">position</span>
              <span className="break-all">
                <a
                  href={CHAIN.explorerToken(
                    result.action === "borrow"
                      ? CHAIN.aave!.USDC_UNDERLYING
                      : CHAIN.aave!.A_WETH,
                    result.ethAddress,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-emerald-100"
                >
                  {result.action === "borrow" ? "USDC" : "aWETH"} balance of{" "}
                  {result.ethAddress.slice(0, 10)}&hellip;
                </a>
              </span>
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
