// SODA end-to-end demo, Sui edition: a Solana program trades on DeepBook.
//
// Same wallet, same committee, same soda program and the same
// finalize_signature check as demo.ts. What changes is the envelope: the
// sui_demo program BCS-encodes a Sui programmable transaction on-chain and
// commits sha256(blake2b(intent || tx)) instead of keccak(rlp). Sui accepts
// the committee's secp256k1 signature natively (scheme flag 0x01), so the
// address a Solana wallet owns on Sui is as real as the one it owns on Base.
//
// Three actions, each ONE Sui transaction through the identical pipeline:
//
//   swap (default) — DeepBook V3: spend SUI, receive DEEP off the order book
//   sell           — DeepBook V3: spend that DEEP, receive SUI
//   transfer       — a plain SUI transfer, kept as a fallback that needs
//                    nothing but the network
//
// The DeepBook actions are the point: a deposit-shaped action proves the
// address can pay, but only its owner can take liquidity off a book and then
// spend the token that came back.

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applySlippage,
  bigintToBe,
  bytesToBigInt,
  bytesToHex0x,
  compressPk,
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
  encodeSuiSignature,
  encodeSuiTransactionData,
  encodeSuiTransferKind,
  formatCoin,
  getSuiChain,
  MIST_PER_SUI,
  parseSuiAddressStrict,
  parseSuiPrivateKey,
  quoteRejection,
  fetchSpendableCoins,
  requestSuiFromFaucet,
  signSuiTransactionWithKey,
  SUI_DEMO_AMOUNT_MIST,
  SUI_MAX_GAS_COINS,
  SUI_MIN_BALANCE_MIST,
  SUI_SPONSOR_MAX_TOPUP_MIST,
  SUI_TRANSFER_GAS_BUDGET_MIST,
  suiAddressFromKey,
  suiAddressFromPk,
  SuiGraphQl,
  suiGraphqlUrl,
  SuiJsonRpc,
  suiRpcUrl,
  suiSigningPayload,
  suiTransactionDigest,
  type DeepBookPool,
  type SuiCoin,
  type SuiObjectRef,
} from "@soda-sdk/core";

// DEMO_CHAIN selects the Sui network (sui-testnet | sui-devnet). demo.sh
// routes here for any sui-* key; the EVM keys go to demo.ts.
const CHAIN = getSuiChain(process.env.DEMO_CHAIN);
const sui = new SuiGraphQl(suiGraphqlUrl(CHAIN));
// Optional. Only the sponsor needs it: a wallet-funded key usually holds its
// SUI in an address balance, which owns no coin objects and so looks empty
// to GraphQL. See SuiJsonRpc.
const suiRpc = (() => {
  const url = suiRpcUrl(CHAIN);
  return url ? new SuiJsonRpc(url) : null;
})();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const SODA_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/soda.json");
const SUI_DEMO_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/sui_demo.json");
const SIGNER_KEY_PATH = resolve(REPO_ROOT, "keyshare.dev.json");

type ActionKey = "swap" | "sell" | "transfer";
const ACTION: ActionKey = (() => {
  const a = (process.env.DEMO_ACTION ?? "swap").trim().toLowerCase();
  if (a === "swap" || a === "sell" || a === "transfer") return a;
  throw new Error(`DEMO_ACTION must be swap, sell or transfer, got "${a}"`);
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtSui(mist: bigint): string {
  return `${(Number(mist) / Number(MIST_PER_SUI)).toFixed(6)} SUI`;
}

function loadOrCreateSignerKey(): Uint8Array {
  if (existsSync(SIGNER_KEY_PATH)) {
    return Uint8Array.from(Buffer.from(readFileSync(SIGNER_KEY_PATH, "utf8").trim(), "hex"));
  }
  const sk = secp256k1.utils.randomPrivateKey();
  writeFileSync(SIGNER_KEY_PATH, Buffer.from(sk).toString("hex"), { mode: 0o600 });
  return sk;
}

function loadSolanaWallet(): Keypair {
  const path = process.env.ANCHOR_WALLET ?? resolve(homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function banner(line: string): void {
  const bar = "═".repeat(line.length + 4);
  console.log(`\n${bar}\n  ${line}\n${bar}\n`);
}

/** Largest coins first, at most SUI_MAX_GAS_COINS: Sui merges them at execution. */
function pickGasCoins(coins: SuiCoin[]): SuiCoin[] {
  return coins.slice(0, SUI_MAX_GAS_COINS);
}

/**
 * A Sui execution that raced someone else to the same bytes. The relayer and
 * this script both submit on `SigCompleted`, and the digest is a pure
 * function of the transaction, so whoever lands first wins and the other
 * sees a duplicate-ish error. demo.ts tolerates the equivalent EVM race
 * ("already known" / "nonce too low"); without this the demo would exit 1
 * on a transaction that in fact succeeded.
 */
function looksAlreadySubmitted(message: string, digest: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes(digest.toLowerCase()) ||
    m.includes("already") ||
    m.includes("objectversionunavailable") ||
    m.includes("not available for consumption")
  );
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

/**
 * Top the derived address up from a sponsor key, so a run does not stall on
 * a human visiting a faucet. Same shape and the same cap as the EVM
 * sponsor: a key in .env (SUI_FUNDER_KEY) holding demo money only. The key
 * is whatever `sui keytool export` / Sui Wallet hands out (`suiprivkey1…`,
 * Ed25519 or secp256k1) or 32 bytes of secp256k1 hex.
 *
 * Every failure here is a fallback, never a crash: the faucet and manual
 * funding are still open, and a sponsor whose coins went stale (the web app
 * spent them a moment ago) must not end the run.
 */
async function fundFromSponsor(target: string, need: bigint): Promise<boolean> {
  const raw = process.env.SUI_FUNDER_KEY?.trim();
  if (!raw) return false;
  let key;
  try {
    key = parseSuiPrivateKey(raw);
  } catch (e) {
    console.log(`  ⚠ SUI_FUNDER_KEY: ${(e as Error).message} — skipping sponsor`);
    return false;
  }
  const sponsor = bytesToHex0x(suiAddressFromKey(key));
  const topUp = need > SUI_SPONSOR_MAX_TOPUP_MIST ? SUI_SPONSOR_MAX_TOPUP_MIST : need;

  try {
    const gasPrice = await sui.getReferenceGasPrice();
    const coins = pickGasCoins(
      await fetchSpendableCoins(sponsor, { graphql: sui, rpc: suiRpc }),
    );
    const available = coins.reduce((n, c) => n + c.balance, 0n);
    console.log(`  sponsor ${sponsor} (${key.scheme}, ${fmtSui(available)} across ${coins.length} coins)`);
    // Gate on the coins actually being spent, not the address total: a
    // sponsor fragmented into many small coins passes a balance check and
    // then fails to pay from the four it hands over.
    if (coins.length === 0 || available < topUp + SUI_TRANSFER_GAS_BUDGET_MIST) {
      console.log(`  ⚠ sponsor's usable coins hold ${fmtSui(available)}, need ${fmtSui(topUp + SUI_TRANSFER_GAS_BUDGET_MIST)} — falling back to the faucet`);
      return false;
    }
    const txBytes = encodeSuiTransactionData({
      kindBytes: encodeSuiTransferKind(parseSuiAddressStrict(target, "sponsor target"), topUp),
      sender: parseSuiAddressStrict(sponsor, "sponsor address"),
      gasPayment: coins.map((c) => c.ref),
      gasPrice,
      gasBudget: SUI_TRANSFER_GAS_BUDGET_MIST,
    });
    const { serialized } = signSuiTransactionWithKey(txBytes, key);
    const res = await sui.executeTransaction(txBytes, [serialized]);
    if (res.status !== "SUCCESS") {
      console.log(`  ⚠ sponsor transfer failed on Sui: ${res.error ?? "unknown"} — falling back to the faucet`);
      return false;
    }
    console.log(`  → sponsored ${fmtSui(topUp)}: ${CHAIN.explorerTx(res.digest)}`);
  } catch (e) {
    console.log(`  ⚠ sponsor transfer could not be submitted: ${(e as Error).message} — falling back to the faucet`);
    return false;
  }
  return waitForBalance(target, need, 60);
}

/** The public faucet: rate-limited per IP, so a 429 is reported, not thrown. */
async function fundFromFaucet(target: string, need: bigint): Promise<boolean> {
  console.log(`  asking ${CHAIN.faucet} for test SUI…`);
  const res = await requestSuiFromFaucet(CHAIN.faucet, target);
  if (res.ok) {
    console.log("  ✓ faucet accepted the request");
    return waitForBalance(target, need, 40);
  }
  console.log(`  ⚠ faucet ${res.status}: ${res.body.trim()}`);
  return false;
}

async function waitForBalance(addr: string, threshold: bigint, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const bal = await sui.getBalance(addr).catch(() => 0n);
    if (bal >= threshold) {
      console.log(`  ✓ funded. balance: ${fmtSui(bal)}`);
      return true;
    }
    await sleep(3_000);
  }
  return false;
}

async function pollForFunding(addr: string, threshold: bigint): Promise<bigint> {
  let last = -1n;
  for (;;) {
    const bal = await sui.getBalance(addr).catch(() => 0n);
    if (bal !== last) {
      process.stdout.write(`\r  current balance: ${fmtSui(bal)}         `);
      last = bal;
    }
    if (bal >= threshold) {
      process.stdout.write("\n");
      return bal;
    }
    await sleep(8_000);
  }
}

// ---------------------------------------------------------------------------
// Building each action's programmable block
// ---------------------------------------------------------------------------

type BuildContext = {
  suiAddressBytes: Uint8Array;
  suiAddress: string;
  gasCoins: SuiCoin[];
  gasPrice: bigint;
  pool: DeepBookPool;
  dryRun: boolean;
};

type BuiltAction = {
  kindBytes: Uint8Array;
  gasBudget: bigint;
  /** Lines describing what will happen, printed before anything is signed. */
  lines: string[];
  /** One-line summary for the closing banner. */
  summary: string;
};

/** Wrap a kind in the same envelope the on-chain program will build. */
function envelope(ctx: BuildContext, kindBytes: Uint8Array, gasBudget: bigint): Uint8Array {
  return encodeSuiTransactionData({
    kindBytes,
    sender: ctx.suiAddressBytes,
    gasPayment: ctx.gasCoins.map((c) => c.ref),
    gasPrice: ctx.gasPrice,
    gasBudget,
  });
}

/** Run a read-only DeepBook quote through simulation. */
async function quoteSwap(ctx: BuildContext, direction: "buy" | "sell", amount: bigint) {
  const kind = deepbookQuoteKind({ pool: ctx.pool, direction, amount });
  const outputs = await sui.simulateReturnValues(envelope(ctx, kind, DEEPBOOK_SWAP_GAS_BUDGET_MIST));
  return decodeDeepbookQuote(outputs, ctx.pool);
}

function deepCoinObjectType(pool: DeepBookPool): string {
  return `0x2::coin::Coin<${pool.base.type}>`;
}

async function buildSwap(ctx: BuildContext): Promise<BuiltAction> {
  const pool = ctx.pool;
  const spend = DEEPBOOK_BUY_QUOTE_MIST;

  // The pre-check, and the Sui equivalent of eth_estimateGas: ask the pool
  // itself what this order would do before any Solana transaction is paid
  // for. A book too thin to fill returns the input untouched rather than
  // reverting, so "would it fill" has to be asked explicitly.
  let minBaseOut = 0n;
  let quoted = "";
  if (!ctx.dryRun) {
    const q = await quoteSwap(ctx, "buy", spend);
    const rejection = quoteRejection(q, pool, "buy");
    if (rejection) throw new Error(`DeepBook would not fill this swap: ${rejection}`);
    minBaseOut = applySlippage(q.baseOut);
    quoted =
      `${formatCoin(q.baseOut, pool.base)} ${pool.base.symbol} out ` +
      `(mid ${q.midPrice.toFixed(6)} ${pool.quote.symbol}/${pool.base.symbol}, ` +
      `min accepted ${formatCoin(minBaseOut, pool.base)})`;
  }

  return {
    kindBytes: deepbookBuyBaseKind({
      pool,
      quoteAmount: spend,
      minBaseOut,
      recipient: ctx.suiAddressBytes,
    }),
    gasBudget: DEEPBOOK_SWAP_GAS_BUDGET_MIST,
    lines: [
      `  action:     DeepBook V3 swap_exact_quote_for_base on ${pool.key}`,
      `  spending:   ${fmtSui(spend)}`,
      ...(quoted ? [`  quoted:     ${quoted}`] : []),
      `  pool:       ${pool.poolId}  (whitelisted: zero fees, no DEEP needed)`,
    ],
    summary: `bought ${pool.base.symbol} with ${fmtSui(spend)} on DeepBook`,
  };
}

async function buildSell(ctx: BuildContext): Promise<BuiltAction> {
  const pool = ctx.pool;
  const deepCoins = await sui.getCoins(ctx.suiAddress, deepCoinObjectType(pool));
  const held = deepCoins.reduce((n, c) => n + c.balance, 0n);
  if (held === 0n) {
    throw new Error(
      `the derived address holds no ${pool.base.symbol} to sell — run the swap action first ` +
        `(DEMO_ACTION=swap DEMO_CHAIN=${CHAIN.key} ./demo.sh)`,
    );
  }
  // Every coin object is spent whole, so the sale size is what is held.
  const coins = deepCoins.slice(0, SUI_MAX_GAS_COINS);
  const selling = coins.reduce((n, c) => n + c.balance, 0n);

  let minQuoteOut = 0n;
  let quoted = "";
  if (!ctx.dryRun) {
    const q = await quoteSwap(ctx, "sell", selling);
    const rejection = quoteRejection(q, pool, "sell");
    if (rejection) throw new Error(`DeepBook would not fill this sale: ${rejection}`);
    minQuoteOut = applySlippage(q.quoteOut);
    quoted = `${fmtSui(q.quoteOut)} out (min accepted ${fmtSui(minQuoteOut)})`;
  }

  return {
    kindBytes: deepbookSellBaseKind({
      pool,
      baseCoins: coins.map((c) => c.ref),
      minQuoteOut,
      recipient: ctx.suiAddressBytes,
    }),
    gasBudget: DEEPBOOK_SWAP_GAS_BUDGET_MIST,
    lines: [
      `  action:     DeepBook V3 swap_exact_base_for_quote on ${pool.key}`,
      `  selling:    ${formatCoin(selling, pool.base)} ${pool.base.symbol} from ${coins.length} coin object(s)`,
      ...(quoted ? [`  quoted:     ${quoted}`] : []),
      `  note:       these are objects the derived address acquired itself, not gas it was given`,
    ],
    summary: `sold ${formatCoin(selling, pool.base)} ${pool.base.symbol} back into ${pool.quote.symbol}`,
  };
}

function buildTransfer(ctx: BuildContext): BuiltAction {
  const recipientHex = process.env.DEMO_RECIPIENT?.trim() || ctx.suiAddress;
  // Strict: a 20-byte EVM address left over from the Base demo would
  // otherwise be zero-padded into a perfectly valid Sui address that nobody
  // controls, and every downstream check would agree with it.
  const recipient = parseSuiAddressStrict(recipientHex, "DEMO_RECIPIENT");
  return {
    kindBytes: encodeSuiTransferKind(recipient, SUI_DEMO_AMOUNT_MIST),
    gasBudget: SUI_TRANSFER_GAS_BUDGET_MIST,
    lines: [
      `  action:     transfer ${fmtSui(SUI_DEMO_AMOUNT_MIST)} → ${recipientHex}` +
        `${recipientHex === ctx.suiAddress ? "  (self)" : ""}`,
    ],
    summary: `transferred ${fmtSui(SUI_DEMO_AMOUNT_MIST)}`,
  };
}

const MIN_BALANCE: Record<ActionKey, bigint> = {
  swap: DEEPBOOK_MIN_BALANCE_MIST,
  sell: SUI_MIN_BALANCE_MIST,
  transfer: SUI_MIN_BALANCE_MIST,
};

// ---------------------------------------------------------------------------

async function main() {
  const DRY_RUN = process.env.SODA_DRY_RUN === "1";

  const walletKp = loadSolanaWallet();
  const wallet = new Wallet(walletKp);
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899", {
    commitment: "confirmed",
    ...(process.env.SOLANA_WS_URL ? { wsEndpoint: process.env.SOLANA_WS_URL } : {}),
  });
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const sodaIdl = JSON.parse(readFileSync(SODA_IDL_PATH, "utf8"));
  const suiDemoIdl = JSON.parse(readFileSync(SUI_DEMO_IDL_PATH, "utf8"));
  const sodaProgram = new Program(sodaIdl, provider);
  const suiDemoProgram = new Program(suiDemoIdl, provider);

  const lamports = await connection.getBalance(walletKp.publicKey);
  const solBal = (lamports / LAMPORTS_PER_SOL).toFixed(2);

  banner(
    ACTION === "transfer"
      ? "SODA demo — a Solana program signs a Sui transaction"
      : "SODA demo — a Solana program trades on DeepBook",
  );

  console.log(`Solana wallet:     ${walletKp.publicKey.toBase58()}  (${solBal} SOL)`);
  console.log(`SODA program:      ${sodaProgram.programId.toBase58()}`);
  console.log(`sui_demo program:  ${suiDemoProgram.programId.toBase58()}`);
  console.log(`Sui network:       ${CHAIN.name}  (${sui.endpoint})`);
  console.log(`action:            ${ACTION}`);

  // --- 1. Dev signer key + committee ---
  const MPC_MODE = !!process.env.MPC_COORDINATOR_URL;
  const devSk = MPC_MODE ? new Uint8Array(32) : loadOrCreateSignerKey();
  let groupPkCompressed = MPC_MODE ? new Uint8Array(33) : secp256k1.getPublicKey(devSk, true);

  const [committeePda] = PublicKey.findProgramAddressSync([Buffer.from("committee")], sodaProgram.programId);
  const committeeAcct = await connection.getAccountInfo(committeePda);
  if (!committeeAcct) {
    if (MPC_MODE) {
      throw new Error("MPC mode requires an existing Committee PDA. Run `pnpm mpc:update-committee` after DKG.");
    }
    console.log("\nInitializing SODA committee on Solana...");
    const sig = await (sodaProgram.methods as any)
      .initCommittee(Array.from(groupPkCompressed))
      .accounts({ committee: committeePda, authority: walletKp.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`  → init_committee tx: ${sig}`);
  } else {
    const committee = await (sodaProgram.account as any).committee.fetch(committeePda);
    const onChain = Buffer.from(committee.groupPk).toString("hex");
    if (MPC_MODE) {
      groupPkCompressed = Uint8Array.from(Buffer.from(onChain, "hex"));
      console.log(`  group_pk (on-chain, MPC):  ${onChain}`);
    } else if (onChain !== Buffer.from(groupPkCompressed).toString("hex")) {
      throw new Error(
        `Committee group_pk mismatch.\n  on-chain: ${onChain}\n  local:    ${Buffer.from(groupPkCompressed).toString("hex")}\n` +
          `Either delete ${SIGNER_KEY_PATH} and rerun, or set MPC_COORDINATOR_URL to use MPC mode.`,
      );
    }
  }

  // --- 2. Derive the Sui address ---
  const derivationSeeds = new Uint8Array(0);
  const tweak = computeTweak(walletKp.publicKey.toBytes(), derivationSeeds, CHAIN.chainTag);
  const foreignPk = deriveForeignPk(groupPkCompressed, tweak);
  const suiAddressBytes = suiAddressFromPk(foreignPk);
  const suiAddress = bytesToHex0x(suiAddressBytes);

  banner(`Solana-derived Sui address:  ${suiAddress}`);
  console.log(`  ${CHAIN.explorerAddress(suiAddress)}`);

  // --- 3. Funding ---
  const threshold = MIN_BALANCE[ACTION];
  let balance = 0n;
  if (!DRY_RUN) {
    balance = await sui.getBalance(suiAddress);
    console.log(`\nCurrent ${CHAIN.name} balance: ${fmtSui(balance)}`);
    if (balance < threshold) {
      const need = threshold - balance;
      const funded = (await fundFromSponsor(suiAddress, threshold)) || (await fundFromFaucet(suiAddress, threshold));
      if (!funded) {
        console.log(`\n→ Fund the address above with ~${fmtSui(need)} more on ${CHAIN.name}:`);
        console.log("    (or set SUI_FUNDER_KEY in .env to auto-fund)");
        console.log(`    web faucet: https://faucet.sui.io  (pick ${CHAIN.key.replace("sui-", "")})`);
        console.log("");
        console.log("Polling for funding (will resume automatically)...");
        await pollForFunding(suiAddress, threshold);
      }
      balance = await sui.getBalance(suiAddress);
      console.log(`✓ Funded. Balance: ${fmtSui(balance)}\n`);
    }
  } else {
    console.log("[dry-run] skipping the Sui funding gate");
  }

  // --- 4. Build the transaction (a preview; the program is the authority) ---
  let gasCoins: SuiCoin[];
  let gasPrice: bigint;
  if (DRY_RUN) {
    // A made-up gas coin: the Solana side does not check it and nothing is
    // broadcast. A random version keeps each dry run's payload distinct, so
    // the SigRequest PDA (seeded by payload) does not already exist.
    gasCoins = [
      {
        ref: {
          objectId: new Uint8Array(32).fill(0x11),
          version: BigInt(Math.floor(Math.random() * 0xffffffff)),
          digest: new Uint8Array(32).fill(0x22),
        },
        balance: 0n,
      },
    ];
    gasPrice = 1000n;
  } else {
    gasCoins = pickGasCoins(await sui.getGasCoins(suiAddress));
    if (gasCoins.length === 0) throw new Error(`no SUI coin objects at ${suiAddress} — is the balance indexed yet?`);
    gasPrice = await sui.getReferenceGasPrice();
  }

  const ctx: BuildContext = {
    suiAddressBytes,
    suiAddress,
    gasCoins,
    gasPrice,
    pool: deepbookPool(CHAIN.key),
    dryRun: DRY_RUN,
  };

  const built =
    ACTION === "swap" ? await buildSwap(ctx) : ACTION === "sell" ? await buildSell(ctx) : buildTransfer(ctx);

  const gasTotal = gasCoins.reduce((n, c) => n + c.balance, 0n);
  if (!DRY_RUN && gasTotal < built.gasBudget) {
    throw new Error(`gas coins hold ${fmtSui(gasTotal)}, need at least the ${fmtSui(built.gasBudget)} budget`);
  }

  const txBytes = envelope(ctx, built.kindBytes, built.gasBudget);
  const payload = suiSigningPayload(txBytes);
  const expectedDigest = suiTransactionDigest(txBytes);

  console.log("Tx:");
  console.log(`  chain:      ${CHAIN.name}`);
  for (const l of built.lines) console.log(l);
  console.log(`  gas coins:  ${gasCoins.map((c) => bytesToHex0x(c.ref.objectId).slice(0, 12) + "…@v" + c.ref.version).join(", ")}`);
  console.log(`  gas price:  ${gasPrice} MIST/unit   budget: ${fmtSui(built.gasBudget)}`);
  console.log(`  kind:       ${built.kindBytes.length} bytes BCS   tx: ${txBytes.length} bytes`);
  console.log(`  digest:     ${expectedDigest}`);
  console.log(`  payload:    ${bytesToHex0x(payload)}  (sha256(blake2b(intent‖tx)))`);

  if (!DRY_RUN) {
    const sim = await sui.simulate(txBytes);
    if (sim.status !== "SUCCESS") throw new Error(`Sui dry-run failed: ${sim.error ?? "unknown"}`);
    console.log("  simulated:  ok");
  }

  // --- 5. Solana: sui_demo::sign_sui_tx (wraps the block, CPIs request_signature) ---
  const [sigRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sig"), walletKp.publicKey.toBuffer(), Buffer.from(payload)],
    sodaProgram.programId,
  );
  const foreignPkXy = foreignPk.subarray(1);

  const rpc = (process.env.SOLANA_RPC_URL ?? "").toLowerCase();
  const solanaCluster: "mainnet" | "devnet" | "local" = rpc.includes("devnet")
    ? "devnet"
    : rpc.includes("mainnet")
      ? "mainnet"
      : "local";
  const solscanTx = (sig: string) =>
    solanaCluster === "local"
      ? "(local validator — not on Solscan)"
      : `https://solscan.io/tx/${sig}${solanaCluster === "devnet" ? "?cluster=devnet" : ""}`;

  console.log("\n[1/3] sui_demo::sign_sui_tx  (Solana program builds BCS, blake2b+sha256, CPIs SODA)");
  const signBuilder = (suiDemoProgram.methods as any)
    .signSuiTx(
      Buffer.from(built.kindBytes),
      gasCoins.map((c) => ({
        objectId: Array.from(c.ref.objectId),
        version: new BN(c.ref.version.toString()),
        digest: Array.from(c.ref.digest),
      })),
      new BN(gasPrice.toString()),
      new BN(built.gasBudget.toString()),
      Array.from(CHAIN.chainTag),
      Buffer.from(derivationSeeds),
    )
    .accounts({
      user: walletKp.publicKey,
      committee: committeePda,
      sigRequest: sigRequestPda,
      sodaProgram: sodaProgram.programId,
      systemProgram: SystemProgram.programId,
    })
    // Two on-chain derivations plus blake2b over the whole envelope. A
    // transfer measured 128k CU; a DeepBook block is longer, so the limit is
    // raised rather than left at the 200k default.
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]);

  // Encode before spending anything: a kind that cannot fit a Solana
  // transaction should say so here, not after the funding and the quote.
  await signBuilder.instruction();
  const signTxSig = await signBuilder.rpc();
  console.log(`      ✓ ${signTxSig}`);
  console.log(`      ↗ ${solscanTx(signTxSig)}`);

  // The program derived the sender and hashed the bytes itself. If either
  // disagreed with this script, the PDA would not exist at this address
  // (payload is a seed) or foreign_pk_xy would differ.
  const sr = await (sodaProgram.account as any).sigRequest.fetch(sigRequestPda);
  const onChainFpk = Buffer.from(sr.foreignPkXy).equals(Buffer.from(foreignPkXy));
  console.log(`      on-chain payload == local:     ${Buffer.from(sr.payload).equals(Buffer.from(payload)) ? "MATCH" : "MISMATCH"}`);
  console.log(`      on-chain foreign_pk == local:  ${onChainFpk ? "MATCH" : "MISMATCH"}`);
  if (!onChainFpk) throw new Error("program derived a different key than this script — refusing to continue");

  // --- 6. Off-chain signing: MPC committee if configured, else local k256 ---
  const MPC_URL = process.env.MPC_COORDINATOR_URL?.replace(/\/+$/, "");
  const MPC_TOKEN = process.env.MPC_COORDINATOR_TOKEN;
  let sigBytes: Uint8Array;
  let recoveryId: number;
  if (MPC_URL) {
    console.log(`\n[*] sign via MPC committee  ${MPC_URL}/sign`);
    const res = await fetch(`${MPC_URL}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(MPC_TOKEN ? { authorization: `Bearer ${MPC_TOKEN}` } : {}) },
      body: JSON.stringify({ sigRequestPubkey: sigRequestPda.toBase58() }),
    });
    if (!res.ok) throw new Error(`mpc coordinator ${res.status}: ${await res.text()}`);
    const sig = (await res.json()) as { r: string; s: string; v: number };
    sigBytes = Buffer.concat([Buffer.from(sig.r, "hex"), Buffer.from(sig.s, "hex")]);
    recoveryId = sig.v;
    console.log(`      ✓ Lindell '17 2-of-2 signature, recovery_id=${recoveryId}`);
  } else {
    const tweakedSkBig = (bytesToBigInt(devSk) + bytesToBigInt(tweak)) % secp256k1.CURVE.n;
    if (tweakedSkBig === 0n) throw new Error("tweaked sk is zero");
    const sig = secp256k1.sign(payload, bigintToBe(tweakedSkBig, 32), { lowS: true });
    sigBytes = sig.toCompactRawBytes();
    recoveryId = sig.recovery!;
  }

  {
    const recPt = secp256k1.Signature.fromCompact(sigBytes).addRecoveryBit(recoveryId).recoverPublicKey(payload);
    const recXy = recPt.toRawBytes(false).subarray(1);
    const ok = Buffer.from(recXy).equals(Buffer.from(foreignPkXy));
    console.log(`      local recover check: ${ok ? "MATCH" : "MISMATCH"}`);
    if (!ok) throw new Error("signature does not recover to the derived key");
  }

  // --- 7. Solana: soda::finalize_signature (on-chain secp256k1_recover) ---
  console.log("\n[2/3] soda::finalize_signature  (on-chain secp256k1_recover verifies)");
  const finalSig = await (sodaProgram.methods as any)
    .finalizeSignature(Array.from(sigBytes), recoveryId)
    .accounts({ committee: committeePda, sigRequest: sigRequestPda, submitter: walletKp.publicKey })
    .rpc();
  console.log(`      ✓ ${finalSig}`);
  console.log(`      ↗ ${solscanTx(finalSig)}`);

  const sigRequest = await (sodaProgram.account as any).sigRequest.fetch(sigRequestPda);
  if (!sigRequest.completed) throw new Error("SigRequest still incomplete");

  // --- 8. Assemble + submit to Sui ---
  const serializedSig = encodeSuiSignature(sigBytes, compressPk(foreignPk));

  if (DRY_RUN) {
    console.log("\n[dry-run] On-chain pipeline verified. Skipping the Sui broadcast.");
    console.log(`tx bytes:  ${bytesToHex0x(txBytes)}`);
    console.log(`signature: ${Buffer.from(serializedSig).toString("base64")}`);
    return;
  }

  console.log(`\n[3/3] Submitting to ${CHAIN.name}...`);
  let digest = expectedDigest;
  try {
    const exec = await sui.executeTransaction(txBytes, [serializedSig]);
    digest = exec.digest;
    if (exec.status !== "SUCCESS") {
      throw new Error(`Sui executed the transaction but it failed: ${exec.error ?? "unknown"} (${CHAIN.explorerTx(digest)})`);
    }
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!looksAlreadySubmitted(msg, expectedDigest)) throw e;
    // Someone else (the relayer) landed the identical bytes first. The
    // digest is a function of the transaction, so ours still names it.
    const seen = await sui.getTransaction(expectedDigest).catch(() => null);
    if (!seen) throw e;
    console.log("      (already submitted by the relayer — using the same digest)");
    if (seen.status === "FAILURE") throw new Error(`Sui reports this transaction failed: ${seen.error ?? "unknown"}`);
  }

  try {
    writeFileSync(resolve(REPO_ROOT, ".last-tx-hash"), digest + "\n");
  } catch {
    /* non-fatal */
  }

  banner("DONE — open these in a browser:");
  console.log(`  Sui side (${CHAIN.name}):  ${CHAIN.explorerTx(digest)}`);
  if (solanaCluster !== "local") {
    console.log(`  Solana side (${solanaCluster}):   ${solscanTx(signTxSig)}`);
    console.log(`                            ${solscanTx(finalSig)}`);
  }
  console.log("");
  console.log(`  from:    ${suiAddress}  (derived from your Solana wallet)`);
  console.log(`  action:  ${built.summary}`);
  console.log(`  digest:  ${digest}\n`);
}

main().catch((e) => {
  console.error("\n✗ demo failed:", e?.message ?? e);
  process.exit(1);
});
