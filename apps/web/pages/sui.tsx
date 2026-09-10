// The Sui demo: the same three steps as pages/index.tsx with a DeepBook
// trade at the end. Same wallet, same committee, same soda program and the
// same finalize_signature; only the envelope differs — the sui_demo program
// BCS-encodes the Sui transaction, hashes it Sui's way, and Sui accepts the
// committee's secp256k1 signature natively (scheme flag 0x01).
//
// Why DeepBook rather than a transfer: a transfer proves the address can pay
// its own gas, which is the least interesting thing about owning an account.
// Trading on Sui's central limit order book means the address takes real
// liquidity and ends up holding a token it never had — and then spends that
// token, which only its owner can do. That is the Sui counterpart of the
// Aave deposit/borrow pair on the EVM page.

import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AnchorProvider, Program, type Wallet } from "@coral-xyz/anchor";
import {
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { QRCodeSVG } from "qrcode.react";
import {
  applySlippage,
  bytesToHex0x,
  computeTweak,
  decodeDeepbookQuote,
  deepbookBuyBaseKind,
  deepbookPool,
  deepbookQuoteKind,
  deepbookSellBaseKind,
  DEEPBOOK_BUY_QUOTE_MIST,
  DEEPBOOK_MIN_BALANCE_MIST,
  DEEPBOOK_SWAP_GAS_BUDGET_MIST,
  deriveForeignPk,
  encodeSuiTransactionData,
  formatCoin,
  getSuiChain,
  quoteRejection,
  SUI_MAX_GAS_COINS,
  suiAddressFromPk,
  SuiGraphQl,
  suiSigningPayload,
  toBase64,
  type DeepBookPool,
  type DeepBookQuote,
  type SuiCoin,
  type SuiObjectRef,
} from "@soda-sdk/core";

import SignAndSendButton from "@/components/SignAndSendButton";
import StepCard from "@/components/StepCard";
import SuiAddressCard, { formatSui } from "@/components/SuiAddressCard";
import Timeline, {
  type Step,
  type TimelineState,
  type TimelineStep,
} from "@/components/Timeline";
import { SODA_PROGRAM_ID, SUI_DEMO_PROGRAM_ID, suiDemoIdl } from "@/lib/idls";

// WalletMultiButton is a client-only component; dynamic-import keeps it
// out of the Next 16 SSR pass (its internals touch `window`).
const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton,
    ),
  { ssr: false },
);

// Reported by /api/group-pk from the SERVER's env; see pages/index.tsx.
type SignerInfo =
  | { mode: "mpc"; coordinator: string }
  | { mode: "dev-key"; source: "env" | "file" | "missing" };

const DOCS_URL =
  process.env.NEXT_PUBLIC_DOCS_URL ?? "https://frontier-docs-cazz.vercel.app";

// Sui network, chosen at build time by NEXT_PUBLIC_SUI_CHAIN
// (sui-testnet | sui-devnet) to mirror the CLI's DEMO_CHAIN. Independent of
// the EVM page's NEXT_PUBLIC_DEMO_CHAIN so the two demos can differ.
const CHAIN = getSuiChain(process.env.NEXT_PUBLIC_SUI_CHAIN);

// Referenced statically because Next only inlines NEXT_PUBLIC_* names it can
// see literally. Mysten's public GraphQL allows browser requests, so the page
// reads balances, quotes and gas coins itself; the server routes have their
// own URL.
const SUI_GRAPHQL =
  process.env.NEXT_PUBLIC_SUI_GRAPHQL_URL ?? CHAIN.defaultGraphql;

// DeepBook is only wired up on the networks the SDK has a pool for. A chain
// without one still gets the page; the trade cards say why they are off.
const POOL: DeepBookPool | null = (() => {
  try {
    return deepbookPool(CHAIN.key);
  } catch {
    return null;
  }
})();

const DEEP_COIN_OBJECT_TYPE = POOL ? `0x2::coin::Coin<${POOL.base.type}>` : null;

// Same five stages as the EVM pipeline, Sui words.
type SuiTimelineKey =
  | "signSuiTx"
  | "sigRequested"
  | "signOffChain"
  | "finalizeOnChain"
  | "submitSui";

type SuiTimeline = TimelineState<SuiTimelineKey>;

const INITIAL_TIMELINE: SuiTimeline = {
  signSuiTx: "idle",
  sigRequested: "idle",
  signOffChain: "idle",
  finalizeOnChain: "idle",
  submitSui: "idle",
};

const SUI_TIMELINE_STEPS: TimelineStep<SuiTimelineKey>[] = [
  {
    key: "signSuiTx",
    label: "Solana: sign_sui_tx",
    sub: "Phantom signs · sui_demo derives the sender, wraps the DeepBook block and CPIs SODA",
  },
  {
    key: "sigRequested",
    label: "SigRequested emitted",
    sub: "SigRequest PDA created on-chain",
  },
  {
    key: "signOffChain",
    label: "Sign the payload",
    sub: "Signs with group_sk + tweak, so the signature recovers to your derived address",
    details: [
      "payload = sha256(blake2b256(intent(0,0,0) || bcs(TransactionData)))",
      "tweak   = sha256(\"SODA-v1\" || owner || path || chain_tag)",
      "sk'     = (group_sk + tweak) mod n",
      "sig     = ecdsa_sign(payload, sk')   [low-s]",
      "recovers to group_pk + tweak·G — exactly what the program stored",
    ],
  },
  {
    key: "finalizeOnChain",
    label: "Solana: finalize_signature",
    sub: "secp256k1_recover verifies the signature matches the program-derived foreign_pk_xy",
  },
  {
    key: "submitSui",
    label: "Submit to Sui",
    sub: "executeTransaction with 0x01 ‖ r ‖ s ‖ pk — Sui checks blake2b(0x01 ‖ pk) == sender",
  },
];

// A stand-in gas coin for the pre-flight instruction encode on an address
// that holds nothing yet. Only the IDL shape is being checked there; nothing
// built with this ref is ever sent.
const PROBE_GAS_REF: SuiObjectRef = {
  objectId: new Uint8Array(32).fill(0x11),
  version: 0n,
  digest: new Uint8Array(32).fill(0x22),
};

// ---------------------------------------------------------------------------
// Actions. Every action is the same pipeline — Phantom signs sign_sui_tx, the
// committee signs the payload, finalize_signature verifies it on-chain, the
// bytes go to Sui — with a different programmable block at the end. This
// table is the ONLY place that differs per action, so adding one is a row.
// ---------------------------------------------------------------------------
type ActionKey = "swap" | "sell";

type BuildInput = {
  pool: DeepBookPool;
  sender: Uint8Array;
  senderHex: string;
  sui: SuiGraphQl;
  /** Wraps a kind in the envelope the on-chain program will rebuild. */
  envelope: (kind: Uint8Array, gasBudget: bigint) => Uint8Array;
};

type Built = {
  kindBytes: Uint8Array;
  /** What the quote said, for the confirmation line and the result panel. */
  quoteLine: string;
};

type ActionDef = {
  key: ActionKey;
  title: string;
  /** The Move call, for the card. */
  callName: string;
  button: string;
  buttonAgain: string;
  description: string;
  /** SUI the derived address must hold before this can run. */
  minBalanceMist: bigint;
  gasBudgetMist: bigint;
  build: (input: BuildInput) => Promise<Built>;
};

/** Run a read-only DeepBook quote through simulation. */
async function quote(
  input: BuildInput,
  direction: "buy" | "sell",
  amount: bigint,
): Promise<DeepBookQuote> {
  const kind = deepbookQuoteKind({ pool: input.pool, direction, amount });
  const outputs = await input.sui.simulateReturnValues(
    input.envelope(kind, DEEPBOOK_SWAP_GAS_BUDGET_MIST),
  );
  return decodeDeepbookQuote(outputs, input.pool);
}

const ACTIONS: Record<ActionKey, ActionDef> = {
  swap: {
    key: "swap",
    title: "Buy DEEP with SUI",
    callName: "pool::swap_exact_quote_for_base",
    button: `Sign & buy DEEP with ${formatSui(DEEPBOOK_BUY_QUOTE_MIST)}`,
    buttonAgain: "Buy again",
    description:
      "Takes liquidity off Sui's central limit order book. The SUI is split " +
      "from the gas coin and the derived address ends up holding DEEP — a " +
      "token it never had, bought at the book's price.",
    minBalanceMist: DEEPBOOK_MIN_BALANCE_MIST,
    gasBudgetMist: DEEPBOOK_SWAP_GAS_BUDGET_MIST,
    build: async (input) => {
      // The pre-check, and the Sui analogue of eth_estimateGas: ask the pool
      // what this order would do before any Solana transaction is paid for.
      // A book too thin to fill returns the input untouched rather than
      // reverting, so "would it fill" has to be asked explicitly.
      const q = await quote(input, "buy", DEEPBOOK_BUY_QUOTE_MIST);
      const rejection = quoteRejection(q, input.pool, "buy");
      if (rejection) throw new Error(`DeepBook would not fill this swap: ${rejection}`);
      const minBaseOut = applySlippage(q.baseOut);
      return {
        kindBytes: deepbookBuyBaseKind({
          pool: input.pool,
          quoteAmount: DEEPBOOK_BUY_QUOTE_MIST,
          minBaseOut,
          recipient: input.sender,
        }),
        quoteLine:
          `${formatCoin(q.baseOut, input.pool.base)} ${input.pool.base.symbol} for ` +
          `${formatSui(DEEPBOOK_BUY_QUOTE_MIST)} (min accepted ` +
          `${formatCoin(minBaseOut, input.pool.base)})`,
      };
    },
  },
  sell: {
    key: "sell",
    title: "Sell DEEP for SUI",
    callName: "pool::swap_exact_base_for_quote",
    button: "Sign & sell the DEEP back",
    buttonAgain: "Sell again",
    description:
      "Spends the DEEP coin objects the address acquired itself, not the gas " +
      "it was given. Only the owner of those objects can move them, which is " +
      "the whole claim.",
    minBalanceMist: DEEPBOOK_SWAP_GAS_BUDGET_MIST,
    gasBudgetMist: DEEPBOOK_SWAP_GAS_BUDGET_MIST,
    build: async (input) => {
      const coins = (
        await input.sui.getCoins(input.senderHex, `0x2::coin::Coin<${input.pool.base.type}>`)
      ).slice(0, SUI_MAX_GAS_COINS);
      const selling = coins.reduce((n, c) => n + c.balance, 0n);
      if (selling === 0n) {
        throw new Error(
          `the derived address holds no ${input.pool.base.symbol} to sell — buy some first`,
        );
      }
      const q = await quote(input, "sell", selling);
      const rejection = quoteRejection(q, input.pool, "sell");
      if (rejection) throw new Error(`DeepBook would not fill this sale: ${rejection}`);
      const minQuoteOut = applySlippage(q.quoteOut);
      return {
        kindBytes: deepbookSellBaseKind({
          pool: input.pool,
          baseCoins: coins.map((c) => c.ref),
          minQuoteOut,
          recipient: input.sender,
        }),
        quoteLine:
          `${formatSui(q.quoteOut)} for ${formatCoin(selling, input.pool.base)} ` +
          `${input.pool.base.symbol} (min accepted ${formatSui(minQuoteOut)})`,
      };
    },
  },
};

type RunResult = {
  action: ActionKey;
  suiAddress: string;
  digest: string;
  explorerTx: string;
  signSuiTxSig: string;
  finalizeSignatureTx: string;
  payloadHex: string;
  quoteLine: string;
};

/** Live view of the derived address on DeepBook, read from the pool itself. */
type Position = {
  suiMist: bigint;
  deepUnits: bigint;
  quote: DeepBookQuote | null;
};

export default function SuiDemo() {
  const [groupPkHex, setGroupPkHex] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set when the server cannot sign or pay. Blocks the demo: proceeding would
  // leave a SigRequest on-chain that nothing will ever finalize. The chain
  // /api/group-pk reports is the EVM one, so it is not compared here; the Sui
  // routes check their own pair of variables per request instead.
  const [configError, setConfigError] = useState<string | null>(null);
  const { publicKey: walletPubkey } = useWallet();

  useEffect(() => {
    fetch("/api/group-pk")
      .then((r) => r.json())
      .then(
        (d: {
          groupPkHex?: string;
          signer?: SignerInfo;
          payer?: "env" | "file" | "missing";
          error?: string;
        }) => {
          if (d.groupPkHex) setGroupPkHex(d.groupPkHex);
          else if (d.error) setLoadError(d.error);
          if (d.signer?.mode === "dev-key" && d.signer.source === "missing") {
            setConfigError(
              "The server has no signer key: neither SODA_SIGNER_KEY_HEX nor " +
                "keyshare.dev.json is present, so /api/sui/finalize cannot sign. " +
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
      .catch((e) =>
        setLoadError(`Could not load committee key: ${(e as Error).message}`),
      );
  }, []);

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
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
            >
              ← EVM demo
            </Link>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
            >
              Docs ↗
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Trade on Sui with nothing but a Solana wallet.
          </h1>
          <p className="mt-3 text-zinc-400">
            Your Solana wallet owns an address on {CHAIN.name}. Buy DEEP on
            DeepBook, Sui&apos;s on-chain order book, and sell it back, one
            Phantom approval each. No bridge, no Sui key anywhere, no second
            wallet. A Solana program builds the exact Sui transaction and
            commits its hash, and{" "}
            <code className="font-mono">secp256k1_recover</code> checks the
            signature on-chain before Sui ever sees it.
          </p>
        </div>

        {configError ? (
          <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            <div className="font-medium">Deployment misconfigured</div>
            <div className="mt-1 text-rose-200/80">{configError}</div>
          </div>
        ) : null}

        {loadError ? (
          <div className="rounded-lg bg-rose-950/40 border border-rose-900 px-4 py-3 text-sm text-rose-200">
            {loadError}
          </div>
        ) : null}

        {/* Everything below is a function of the connected wallet: the
            address, the balance, the result. Keying on the wallet remounts
            it on a change, so a stale address from the previous wallet can
            never be shown — the React way to reset state on a prop change,
            without a setState-in-effect. */}
        <SuiFlow
          key={walletPubkey?.toBase58() ?? "disconnected"}
          groupPkHex={groupPkHex}
          configError={configError}
        />
      </main>
    </div>
  );
}

function SuiFlow({
  groupPkHex,
  configError,
}: {
  groupPkHex: string | null;
  configError: string | null;
}) {
  const [suiAddress, setSuiAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<SuiTimeline>(INITIAL_TIMELINE);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<ActionKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { publicKey: walletPubkey, connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const sui = useMemo(() => new SuiGraphQl(SUI_GRAPHQL), []);

  // Derivation is deliberately NOT automatic. Each step of the demo is one
  // button, so the audience sees the address appear as a distinct act rather
  // than as page furniture that was already there on load.
  const onDerive = () => {
    if (!groupPkHex || !walletPubkey) {
      setError("committee key not loaded yet");
      return;
    }
    setError(null);
    try {
      // The address belongs to the CONNECTED WALLET, not to the committee.
      // sui_demo derives the same value on-chain from the signer and puts it
      // in the signed bytes as the sender, so this is a preview of what the
      // program will compute — connect a different wallet and you get a
      // different address.
      const groupPk = Uint8Array.from(
        Buffer.from(groupPkHex.replace(/^0x/, ""), "hex"),
      );
      const tweak = computeTweak(
        walletPubkey.toBytes(),
        new Uint8Array(0),
        CHAIN.chainTag,
      );
      const foreignPk = deriveForeignPk(groupPk, tweak);
      setSuiAddress(bytesToHex0x(suiAddressFromPk(foreignPk)));
    } catch (e) {
      setError(`derivation failed: ${(e as Error).message}`);
    }
  };

  // Largest coins first, at most SUI_MAX_GAS_COINS; Sui merges them at
  // execution, so a fragmented balance still pays.
  const pickGasCoins = useCallback(
    async (addr: string): Promise<SuiCoin[]> =>
      (await sui.getGasCoins(addr)).slice(0, SUI_MAX_GAS_COINS),
    [sui],
  );

  useEffect(() => {
    if (!suiAddress) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const b = await sui.getBalance(suiAddress);
        if (!cancelled) {
          setBalance(b);
          setBalanceError(null);
        }
      } catch (e) {
        // Show it on the card: a stuck "—" with the reason only in the
        // console makes an endpoint problem look like a derivation bug.
        if (!cancelled) {
          let host = SUI_GRAPHQL;
          try {
            host = new URL(SUI_GRAPHQL).host;
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
  }, [suiAddress, sui]);

  // DeepBook's own view of the derived address. Nothing here is computed by
  // us: the balances are Sui's and the price and size come from simulating
  // read-only calls against the pool, so what the audience sees is what
  // DeepBook believes about a Solana wallet.
  useEffect(() => {
    if (!suiAddress || !POOL || !DEEP_COIN_OBJECT_TYPE) return;
    const pool = POOL;
    let cancelled = false;
    const tick = async () => {
      try {
        const [suiMist, deepUnits, gasCoins] = await Promise.all([
          sui.getBalance(suiAddress),
          sui.getBalance(suiAddress, pool.base.type),
          pickGasCoins(suiAddress),
        ]);
        // The quote is a simulation, and a simulation still needs a gas
        // object it could pay from. An address with nothing yet gets
        // balances only rather than an error where the price should be.
        let q: DeepBookQuote | null = null;
        if (gasCoins.length > 0) {
          const gasPrice = await sui.getReferenceGasPrice();
          const kind = deepbookQuoteKind({
            pool,
            direction: "buy",
            amount: DEEPBOOK_BUY_QUOTE_MIST,
          });
          const txBytes = encodeSuiTransactionData({
            kindBytes: kind,
            sender: Uint8Array.from(Buffer.from(suiAddress.replace(/^0x/, ""), "hex")),
            gasPayment: gasCoins.map((c) => c.ref),
            gasPrice,
            gasBudget: DEEPBOOK_SWAP_GAS_BUDGET_MIST,
          });
          q = decodeDeepbookQuote(await sui.simulateReturnValues(txBytes), pool);
        }
        if (cancelled) return;
        setPosition({ suiMist, deepUnits, quote: q });
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
  }, [suiAddress, sui, pickGasCoins]);

  const runAction = async (actionKey: ActionKey) => {
    if (busy) return;
    const def = ACTIONS[actionKey];
    if (!POOL) {
      setError(`DeepBook is not configured for ${CHAIN.name}`);
      return;
    }
    if (!anchorWallet || !walletPubkey) {
      setError("connect Phantom first");
      return;
    }
    if (!groupPkHex || !suiAddress) {
      setError("group_pk not loaded yet");
      return;
    }

    setError(null);
    setResult(null);
    setTimeline(INITIAL_TIMELINE);
    setBusy(true);
    setRunning(actionKey);

    const updateStep = (name: SuiTimelineKey, status: Step) =>
      setTimeline((prev) => ({ ...prev, [name]: status }));

    try {
      // -------- 1. Preview the derivation in the browser --------
      // The program derives foreign_pk itself from the signer, so nothing here
      // is authoritative — we compute it only to build the transaction and to
      // show the user which address will move. If this disagreed with the
      // program, the SigRequest PDA would sit at a different address (the
      // payload is a seed) and finalize would refuse.
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
      const senderBytes = suiAddressFromPk(foreignPk);
      const sender = bytesToHex0x(senderBytes);

      // -------- 2. Program handles --------
      const sodaProgramId = new PublicKey(SODA_PROGRAM_ID);
      const [committeePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("committee")],
        sodaProgramId,
      );
      const provider = new AnchorProvider(connection, anchorWallet as Wallet, {
        commitment: "confirmed",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const suiDemoProgram = new Program(suiDemoIdl as any, provider);

      // The tx bytes, their payload, and the Solana instruction that commits
      // them, from one set of gas coins. A function because the coin set
      // changes if the address gets funded below.
      const assemble = (kindBytes: Uint8Array, refs: SuiObjectRef[], gasPrice: bigint) => {
        const txBytes = encodeSuiTransactionData({
          kindBytes,
          sender: senderBytes,
          gasPayment: refs,
          gasPrice,
          gasBudget: def.gasBudgetMist,
        });
        const payload = suiSigningPayload(txBytes);
        const [sigRequestPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("sig"), walletPubkey.toBuffer(), Buffer.from(payload)],
          sodaProgramId,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const builder = (suiDemoProgram.methods as any)
          .signSuiTx(
            Buffer.from(kindBytes),
            refs.map((r) => ({
              objectId: Array.from(r.objectId),
              version: new BN(r.version.toString()),
              digest: Array.from(r.digest),
            })),
            new BN(gasPrice.toString()),
            new BN(def.gasBudgetMist.toString()),
            Array.from(CHAIN.chainTag),
            Buffer.from(derivationSeeds),
          )
          .accounts({
            user: walletPubkey,
            committee: committeePda,
            sigRequest: sigRequestPda,
            sodaProgram: sodaProgramId,
            systemProgram: SystemProgram.programId,
          })
          // Two on-chain derivations (sui_demo + soda) plus blake2b over the
          // whole envelope. A transfer measured 128k CU; a DeepBook block is
          // longer, so the limit is raised rather than left at the default.
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ]);
        return { txBytes, payload, sigRequestPda, builder };
      };

      // -------- 3. Encode the Solana instruction now, before anything is
      // spent. A committed web IDL that has drifted from the program fails
      // here with "provided too many arguments" instead of after the sponsor
      // top-up. An unfunded address has no coin yet, so a stand-in stands in.
      let coins = await pickGasCoins(sender);
      let gasPrice = await sui.getReferenceGasPrice();
      await assemble(
        new Uint8Array([0x00, 0x00, 0x00]), // shape-only probe; never sent
        coins.length ? coins.map((c) => c.ref) : [PROBE_GAS_REF],
        gasPrice,
      ).builder.instruction();

      // -------- 4. Fund the derived address --------
      // Gas is paid from the sender's own coins, and the swap spends SUI on
      // top of that, so this address needs SUI of its own. /api/sui/fund is
      // idempotent and returns immediately if already funded; it runs inside
      // `busy` because a faucet can take a minute.
      let current = await sui.getBalance(sender);
      setBalance(current);
      if (current < def.minBalanceMist) {
        const fundRes = await fetch("/api/sui/fund", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chain: CHAIN.key,
            address: sender,
            minMist: def.minBalanceMist.toString(),
          }),
        });
        const fundJson = (await fundRes.json()) as {
          funded?: boolean;
          balanceMist?: string;
          error?: string;
        };
        if (!fundRes.ok || !fundJson.funded) {
          throw new Error(fundJson.error ?? "could not fund the derived address");
        }
        current = fundJson.balanceMist ? BigInt(fundJson.balanceMist) : await sui.getBalance(sender);
        setBalance(current);
        if (current < def.minBalanceMist) {
          throw new Error(
            `${sender} holds ${formatSui(current)} but this action needs ` +
              `${formatSui(def.minBalanceMist)}. Top it up at https://faucet.sui.io ` +
              `(pick ${CHAIN.key.replace("sui-", "")}) and try again.`,
          );
        }
        // The top-up is a NEW coin object at this address, so the refs read
        // above are stale: bytes naming them would commit to a gas payment
        // Sui rejects. Re-read before building anything that gets signed.
        coins = await pickGasCoins(sender);
        gasPrice = await sui.getReferenceGasPrice();
      }
      if (coins.length === 0) {
        throw new Error(
          `no SUI coin objects at ${sender} yet — the indexer may be a few seconds behind; click again`,
        );
      }

      // -------- 5. Quote and build the DeepBook block --------
      // Built only now, from the post-funding coin set, because the quote's
      // simulation and the transaction itself must name the same objects.
      const buildInput: BuildInput = {
        pool: POOL,
        sender: senderBytes,
        senderHex: sender,
        sui,
        envelope: (kind, gasBudget) =>
          encodeSuiTransactionData({
            kindBytes: kind,
            sender: senderBytes,
            gasPayment: coins.map((c) => c.ref),
            gasPrice,
            gasBudget,
          }),
      };
      const built = await def.build(buildInput);

      const gasTotal = coins.reduce((n, c) => n + c.balance, 0n);
      if (gasTotal < def.gasBudgetMist) {
        throw new Error(
          `gas coins hold ${formatSui(gasTotal)}, need at least the ${formatSui(def.gasBudgetMist)} budget`,
        );
      }

      // -------- 6. The bytes the program will commit --------
      const { txBytes, payload, sigRequestPda, builder } = assemble(
        built.kindBytes,
        coins.map((c) => c.ref),
        gasPrice,
      );

      // -------- 7. Ask a Sui node to dry-run them --------
      // A spent coin, a short budget or a pool that moved shows up here,
      // before Phantom signed, the committee signed, and two Solana
      // transactions were paid for.
      const sim = await sui.simulate(txBytes);
      if (sim.status !== "SUCCESS") {
        throw new Error(`Sui dry-run failed for ${sender}: ${sim.error ?? "unknown"}`);
      }

      // -------- 8. Phantom signs sui_demo::sign_sui_tx --------
      updateStep("signSuiTx", "active");
      const signTxSig: string = await builder.rpc();

      updateStep("signSuiTx", "done");
      updateStep("sigRequested", "done");

      // -------- 9. Backend: sign + finalize + submit to Sui --------
      updateStep("signOffChain", "active");
      const finalizeRes = await fetch("/api/sui/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chain: CHAIN.key,
          sigRequestPda: sigRequestPda.toBase58(),
          // The program stored only the hash; the route re-hashes these and
          // refuses unless they are exactly what was committed on-chain.
          txBytesB64: toBase64(txBytes),
        }),
      });
      if (!finalizeRes.ok) {
        const t = await finalizeRes.text();
        throw new Error(`/api/sui/finalize ${finalizeRes.status}: ${t}`);
      }
      const finalize = (await finalizeRes.json()) as {
        digest: string;
        finalizeSignatureTx: string;
        recoveryId: number;
        suiAddress: string;
        explorerTx: string;
      };

      updateStep("signOffChain", "done");
      updateStep("finalizeOnChain", "done");
      updateStep("submitSui", "done");

      setResult({
        action: actionKey,
        suiAddress: finalize.suiAddress,
        digest: finalize.digest,
        explorerTx: finalize.explorerTx,
        signSuiTxSig: signTxSig,
        finalizeSignatureTx: finalize.finalizeSignatureTx,
        payloadHex: bytesToHex0x(payload),
        quoteLine: built.quoteLine,
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setError(msg);
      setTimeline((prev) => {
        const next = { ...prev };
        (Object.keys(next) as SuiTimelineKey[]).forEach((k) => {
          if (next[k] === "active") next[k] = "error";
        });
        return next;
      });
    } finally {
      setBusy(false);
      setRunning(null);
    }
  };

  // Funding is not a gate: an unfunded address is topped up on click.
  const buttonDisabled = !connected || !suiAddress || !!configError || !POOL;

  // Three explicit steps. Each is complete only when its own artifact exists,
  // so the stepper reflects real state rather than a counter we increment.
  const step1Done = connected && !!walletPubkey;
  const step2Done = !!suiAddress;
  const step3Done = !!result;
  const activeStep = !step1Done ? 1 : !step2Done ? 2 : 3;

  const xray = (sig: string) =>
    `https://xray.helius.xyz/tx/${sig}?network=devnet`;

  return (
    <>
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
                Phantom on devnet. This wallet is the <em>owner</em> — the Sui
                address in the next step is derived from its public key, and
                only it can request a signature for that address.
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
          title="Derive your Sui address"
          state={step2Done ? "done" : activeStep === 2 ? "active" : "locked"}
        >
          {step2Done ? (
            <>
              <SuiAddressCard
                suiAddress={suiAddress}
                balanceMist={balance}
                loading={false}
                balanceError={balanceError}
              />
              <p className="mt-3 text-xs text-zinc-500">
                This is a pure function of your wallet:{" "}
                <code className="font-mono">
                  blake2b256(0x01 ‖ compress(group_pk + tweak·G))
                </code>{" "}
                where{" "}
                <code className="font-mono">
                  tweak = sha256(domain ‖ your&nbsp;pubkey ‖ path ‖ chain)
                </code>
                . No registry, nothing stored — connect a different wallet
                and you get a different address; the same wallet gets a
                different one per chain.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-zinc-400">
                Compute the {CHAIN.name} address that your Solana wallet
                owns. The <code className="font-mono">sui_demo</code> program
                derives the same value on-chain from whoever signs and puts it
                in the signed bytes as the sender, so the caller can never
                name an address it does not control.
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

        {/* ---------- STEP 3 · trade ---------- */}
        <StepCard
          n={3}
          title={`Trade on DeepBook · ${CHAIN.name}`}
          state={step3Done ? "done" : activeStep === 3 ? "active" : "locked"}
        >
          <p className="text-xs text-zinc-500">
            Each button is one Phantom approval. The Solana program BCS-encodes
            the exact DeepBook transaction, the committee signs its hash, and{" "}
            <code className="font-mono">secp256k1_recover</code> checks the
            signature on-chain before it is submitted. Gas is topped up
            automatically from the sponsor key or the faucet.
          </p>

          {POOL ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {(Object.values(ACTIONS) as ActionDef[]).map((def) => {
                const done = result?.action === def.key;
                const nothingToSell =
                  def.key === "sell" && position !== null && position.deepUnits === 0n;
                return (
                  <div
                    key={def.key}
                    className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/40 p-4"
                  >
                    <div className="text-sm font-medium text-zinc-100">
                      {def.title}
                    </div>
                    <div className="mt-1 font-mono text-xs text-emerald-200">
                      DeepBook V3 · {def.callName}
                    </div>
                    <p className="mt-2 flex-1 text-xs text-zinc-500">
                      {def.description}
                    </p>
                    {nothingToSell ? (
                      <p className="mt-2 text-xs text-amber-300/80">
                        The address holds no {POOL.base.symbol} yet — buy some
                        first.
                      </p>
                    ) : null}
                    <div className="mt-4">
                      <SignAndSendButton
                        disabled={
                          buttonDisabled ||
                          (busy && running !== def.key) ||
                          nothingToSell
                        }
                        busy={running === def.key}
                        label={done ? def.buttonAgain : def.button}
                        onClick={() => runAction(def.key)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-sm text-amber-300/80">
              No DeepBook pool is configured for {CHAIN.name}. Switch
              NEXT_PUBLIC_SUI_CHAIN to sui-testnet to trade.
            </p>
          )}
        </StepCard>
      </div>

      {/* DeepBook's own view of the derived address. Every number is read
          from Sui or simulated against the pool, so what the audience sees is
          what DeepBook believes about a Solana wallet. */}
      {suiAddress && POOL ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-xs uppercase tracking-wider text-zinc-500">
              DeepBook V3 · live from the {POOL.key.replace("_", "/")} pool on{" "}
              {CHAIN.name}
            </div>
            <div className="text-xs text-zinc-600">refreshes every 8s</div>
          </div>
          {position ? (
            <div className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <div className="text-xs text-zinc-500">SUI held</div>
                <div className="mt-0.5 font-mono text-emerald-200">
                  {formatSui(position.suiMist)}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  pays gas and buys {POOL.base.symbol}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500">
                  {POOL.base.symbol} held
                </div>
                <div className="mt-0.5 font-mono text-emerald-200">
                  {formatCoin(position.deepUnits, POOL.base)} {POOL.base.symbol}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  bought on the book, spendable by its owner alone
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500">Mid price</div>
                <div className="mt-0.5 font-mono text-zinc-200">
                  {position.quote
                    ? `${position.quote.midPrice.toFixed(6)} ${POOL.quote.symbol}/${POOL.base.symbol}`
                    : "—"}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {position.quote
                    ? `${formatSui(DEEPBOOK_BUY_QUOTE_MIST)} buys ${formatCoin(position.quote.baseOut, POOL.base)} ${POOL.base.symbol}`
                    : "fund the address to price an order"}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500">Fees</div>
                <div className="mt-0.5 font-mono text-zinc-200">
                  {position.quote?.whitelisted ?? POOL.whitelisted
                    ? "0 (whitelisted pool)"
                    : `${formatCoin(position.quote?.deepRequired ?? 0n, POOL.base)} DEEP`}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  no DEEP needed to trade, so gas is the only funding step
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm text-zinc-500">
              {positionError ? `could not read the pool: ${positionError}` : "reading…"}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            <a
              href={CHAIN.explorerAddress(POOL.poolId)}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-zinc-300"
            >
              pool object →
            </a>
            <a
              href={CHAIN.explorerAddress(suiAddress)}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-zinc-300"
            >
              derived address →
            </a>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg bg-rose-950/40 border border-rose-900 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      <Timeline state={timeline} steps={SUI_TIMELINE_STEPS} />

      {result ? (
        <div className="rounded-2xl border border-emerald-800 bg-emerald-950/30 p-6 space-y-4">
          <div className="text-xs uppercase tracking-wider text-emerald-400">
            Done · verify on both chains
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            {/* Sui side */}
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-emerald-300/70">
                {CHAIN.name} · Suiscan
              </div>
              <div className="rounded-lg bg-white p-3">
                <QRCodeSVG
                  value={result.explorerTx}
                  size={160}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="M"
                  className="mx-auto block"
                />
              </div>
              <a
                href={result.explorerTx}
                target="_blank"
                rel="noreferrer"
                className="block break-all font-mono text-xs text-emerald-200 underline hover:text-emerald-100"
              >
                {result.digest}
              </a>
            </div>

            {/* Solana side */}
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-emerald-300/70">
                Solana · finalize_signature (Helius XRAY)
              </div>
              <div className="rounded-lg bg-white p-3">
                <QRCodeSVG
                  value={xray(result.finalizeSignatureTx)}
                  size={160}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="M"
                  className="mx-auto block"
                />
              </div>
              <a
                href={xray(result.finalizeSignatureTx)}
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
              {result.suiAddress} (derived from your Solana wallet)
            </span>
            <span className="text-emerald-300/50">action</span>
            <span className="break-all">
              {ACTIONS[result.action].title} · {ACTIONS[result.action].callName}
            </span>
            <span className="text-emerald-300/50">quoted</span>
            <span className="break-all">{result.quoteLine}</span>
            <span className="text-emerald-300/50">digest</span>
            <span className="break-all">{result.digest}</span>
            <span className="text-emerald-300/50">payload</span>
            <span className="break-all">{result.payloadHex}</span>
            <span className="text-emerald-300/50">soda program</span>
            <span className="break-all">{SODA_PROGRAM_ID}</span>
            <span className="text-emerald-300/50">sui_demo program</span>
            <span className="break-all">{SUI_DEMO_PROGRAM_ID}</span>
            <span className="text-emerald-300/50">sign_sui_tx</span>
            <span className="break-all">{result.signSuiTxSig}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}
