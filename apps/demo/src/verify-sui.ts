// SODA proof tool, Sui edition — given a Sui transaction digest, walks the
// cryptographic chain that ties the Solana program to the Sui transaction
// and prints an audit trail.
//
// Usage:
//   pnpm verify:sui <SUI_TX_DIGEST>
//   DEMO_CHAIN=sui-testnet pnpm verify:sui DgY8tq1E…
//
// Reads only public state:
//   - Sui: the finalized transaction's BCS bytes, sender and signatures
//   - Solana: the SigRequest PDA + the Committee PDA
// No private keys are needed for verification — that's the point.

import { AnchorProvider, Program, type Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bytesToBigInt,
  bytesToHex0x,
  chainFamily,
  compressPk,
  computeTweak,
  decodeSuiSignature,
  deriveForeignPk,
  getSuiChain,
  suiAddressFromPk,
  SuiGraphQl,
  suiGraphqlUrl,
  suiSigningPayload,
  suiTransactionDigest,
} from "@soda-sdk/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const SODA_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/soda.json");

// Load .env from the repo root so SOLANA_DEVNET_RPC_URL etc. are picked up.
(() => {
  const envPath = resolve(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
  if (process.env.SOLANA_CLUSTER === "devnet" && !process.env.SOLANA_RPC_URL) {
    process.env.SOLANA_RPC_URL = process.env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  }
})();

// DEMO_CHAIN is shared with the EVM demo, and the repo's .env sets it to an
// EVM chain, so reading it blindly made the documented bare
// `pnpm verify:sui <digest>` throw "unknown Sui chain base-sepolia" before
// touching the network. Take DEMO_CHAIN only when it names a Sui network,
// else SUI_CHAIN (what the relayer uses), else the default.
const CHAIN = getSuiChain(
  chainFamily(process.env.DEMO_CHAIN) === "sui" ? process.env.DEMO_CHAIN : process.env.SUI_CHAIN,
);

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function loadRequester(): PublicKey {
  // The SigRequest PDA is seeded by (requester, payload). The requester is
  // whoever signed sign_sui_transfer: by default the CLI wallet, or any
  // account named in VERIFY_REQUESTER, so a web run (Phantom) can be audited.
  const override = process.env.VERIFY_REQUESTER?.trim();
  if (override) return new PublicKey(override);
  const path = process.env.ANCHOR_WALLET ?? resolve(homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))).publicKey;
}

function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const status = ok ? `${C.green}MATCH${C.reset}` : `${C.red}MISMATCH${C.reset}`;
  console.log(`  ${mark} ${label}: ${status}${detail ? `  ${C.dim}(${detail})${C.reset}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function section(num: string, title: string) {
  console.log(`\n${C.bold}${C.cyan}[${num}] ${title}${C.reset}`);
}

function explorerUrl(cluster: "devnet" | "mainnet" | "local", what: "tx" | "account", id: string): string {
  if (cluster === "local") return "(local validator — not public)";
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/${what}/${id}${suffix}`;
}

/**
 * Sui's GraphQL returns the bare `TransactionData` for `transactionBcs`
 * (verified on testnet), but a node or schema version could hand back the
 * `SenderSignedData` envelope instead: `uleb(1) || intent(3) ||
 * TransactionData || uleb(sigCount) || (uleb(len) || sig)*`.
 *
 * The digest is the arbiter — whichever slice hashes to the digest under
 * audit is the transaction — so a wrong guess here cannot make a bad
 * transaction verify, only make a good one fail to parse.
 */
function extractTransactionData(bcs: Uint8Array, digest: string, sigs: Uint8Array[]): Uint8Array {
  if (suiTransactionDigest(bcs) === digest) return bcs;

  const ulebWidth = (n: number) => (n < 128 ? 1 : n < 16_384 ? 2 : 3);
  // The outer SizeOneVec length is always 1; the signature count is a
  // separate uleb at the start of the trailer.
  const trailer = ulebWidth(sigs.length) + sigs.reduce((n, s) => n + ulebWidth(s.length) + s.length, 0);
  const header = 1 + 3; // SizeOneVec(1) + intent(3)
  if (bcs.length > header + trailer && bcs[0] === 1) {
    const inner = bcs.subarray(header, bcs.length - trailer);
    if (suiTransactionDigest(inner) === digest) return inner;
  }
  throw new Error(
    `could not locate TransactionData matching digest ${digest} in the node's ${bcs.length}-byte response ` +
      `(first bytes ${bytesToHex0x(bcs.subarray(0, 8))})`,
  );
}

async function main() {
  const digest = process.argv[2] || process.env.VERIFY_TX;
  if (!digest || digest.startsWith("0x")) {
    console.error(`${C.red}usage: pnpm verify:sui <SUI_TX_DIGEST>${C.reset}`);
    console.error("example: pnpm verify:sui DgY8tq1ETaqXhrDU9wxHbNk75RNBNpdd7amwpeZU4u9p");
    process.exit(1);
  }

  const solanaRpc = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
  const cluster: "devnet" | "mainnet" | "local" = solanaRpc.toLowerCase().includes("devnet")
    ? "devnet"
    : solanaRpc.toLowerCase().includes("mainnet")
      ? "mainnet"
      : "local";
  const sui = new SuiGraphQl(suiGraphqlUrl(CHAIN));

  console.log(`${C.bold}╔═══════════════════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}║  SODA PROOF AUDIT — Solana program controls a Sui address                 ║${C.reset}`);
  console.log(`${C.bold}╚═══════════════════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`${C.dim}Sui GraphQL:  ${sui.endpoint}  (${CHAIN.name})${C.reset}`);
  console.log(`${C.dim}Solana RPC:   ${solanaRpc.split("?")[0]}  (${cluster})${C.reset}`);

  // --- 1. Fetch the Sui transaction ---
  section("1", `Fetch the finalized transaction from ${CHAIN.name}`);
  // Finality and indexing are separate on Sui: `executeTransaction` returns
  // once the transaction is final, but GraphQL reads can lag it by a few
  // seconds, so auditing straight after a demo run would otherwise report
  // "no such transaction" for one that certainly exists.
  let tx = await sui.getTransaction(digest);
  for (let i = 0; !tx && i < 20; i++) {
    if (i === 0) process.stdout.write(`  ${C.dim}waiting for the indexer…${C.reset}`);
    else process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3_000));
    tx = await sui.getTransaction(digest);
  }
  if (tx) process.stdout.write("\n");
  if (!tx) throw new Error(`${CHAIN.name} has no transaction ${digest} (not indexed yet, or wrong network?)`);
  if (tx.signatures.length === 0) throw new Error("transaction carries no user signatures");
  const txBytes = extractTransactionData(tx.txBytes, digest, tx.signatures);
  console.log(`  digest:      ${tx.digest}`);
  console.log(`  sender:      ${tx.sender}`);
  console.log(`  status:      ${tx.status === "SUCCESS" ? `${C.green}success${C.reset}` : `${C.red}${tx.status ?? "unknown"}${C.reset}`}${tx.error ? `  (${tx.error})` : ""}`);
  console.log(`  checkpoint:  ${tx.checkpoint ?? "(pending)"}  ${C.dim}${tx.timestamp ?? ""}${C.reset}`);
  console.log(`  tx bytes:    ${txBytes.length} bytes BCS`);
  console.log(`  ${C.dim}explorer: ${CHAIN.explorerTx(digest)}${C.reset}`);
  check("blake2b(\"TransactionData::\" ‖ bytes) == digest", suiTransactionDigest(txBytes) === digest);

  // --- 2. The signature Sui accepted ---
  section("2", "Decode the user signature Sui verified");
  const sig = decodeSuiSignature(tx.signatures[0]);
  const sigR = sig.signature.subarray(0, 32);
  const sigS = sig.signature.subarray(32, 64);
  const sigPkAddress = bytesToHex0x(suiAddressFromPk(sig.publicKey));
  console.log(`  scheme:      secp256k1 (flag 0x01)`);
  console.log(`  r:           ${bytesToHex0x(sigR)}`);
  console.log(`  s:           ${bytesToHex0x(sigS)}`);
  console.log(`  pubkey:      ${bytesToHex0x(sig.publicKey)}`);
  check("blake2b(0x01 ‖ pubkey) == sender", sigPkAddress.toLowerCase() === tx.sender.toLowerCase(),
    "Sui's own rule: the address is the hash of the key that signed");

  // --- 3. Recompute the payload ---
  section("3", "Recompute the payload: sha256(blake2b(intent ‖ tx bytes))");
  const payload = suiSigningPayload(txBytes);
  console.log(`  payload:     ${bytesToHex0x(payload)}`);

  // --- 4. Locate the SigRequest PDA ---
  section("4", "Locate the SigRequest PDA on Solana");
  const sodaIdl = JSON.parse(readFileSync(SODA_IDL_PATH, "utf8"));
  const requester = loadRequester();
  const readOnly: Wallet = {
    publicKey: requester,
    payer: Keypair.generate(),
    async signTransaction(t) { return t; },
    async signAllTransactions(ts) { return ts; },
  };
  const connection = new Connection(solanaRpc, "confirmed");
  const provider = new AnchorProvider(connection, readOnly, { commitment: "confirmed" });
  const sodaProgram = new Program(sodaIdl as any, provider);

  const [sigRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sig"), requester.toBuffer(), Buffer.from(payload)],
    sodaProgram.programId,
  );
  console.log(`  requester:    ${requester.toBase58()}  ${C.dim}(${process.env.VERIFY_REQUESTER ? "VERIFY_REQUESTER" : "your CLI wallet"})${C.reset}`);
  console.log(`  sig_request:  ${sigRequestPda.toBase58()}`);
  console.log(`  ${C.dim}explorer:     ${explorerUrl(cluster, "account", sigRequestPda.toBase58())}${C.reset}`);

  const sr = await (sodaProgram.account as any).sigRequest.fetch(sigRequestPda);
  console.log(`  payload:      ${bytesToHex0x(Uint8Array.from(sr.payload))}`);
  console.log(`  foreign_pk:   ${bytesToHex0x(Uint8Array.from(sr.foreignPkXy))}`);
  console.log(`  chain_tag:    ${Buffer.from(sr.chainTag).toString("utf8").replace(/\0+$/, "")}`);
  console.log(`  signature:    ${bytesToHex0x(Uint8Array.from(sr.signature))}`);
  console.log(`  recovery_id:  ${sr.recoveryId}`);
  console.log(`  completed:    ${sr.completed}`);

  check("PDA exists for the payload Sui verified", Buffer.from(sr.payload).equals(Buffer.from(payload)),
    "SigRequest.payload == sha256(blake2b(intent ‖ tx))");
  check("SigRequest is completed", sr.completed === true);
  check("SigRequest.chain_tag names this Sui network", Buffer.from(sr.chainTag).equals(Buffer.from(CHAIN.chainTag)));

  // --- 5. Same signature on both chains ---
  section("5", "Recover the signing pubkey from the ECDSA signature");
  const onChainSig = Uint8Array.from(sr.signature);
  check("Solana SigRequest.signature == Sui tx (r,s)",
    Buffer.from(onChainSig.subarray(0, 32)).equals(Buffer.from(sigR)) && Buffer.from(onChainSig.subarray(32)).equals(Buffer.from(sigS)),
    "the same 64 bytes lived on Solana before Sui saw them");

  const recovered = new secp256k1.Signature(bytesToBigInt(sigR), bytesToBigInt(sigS))
    .addRecoveryBit(sr.recoveryId)
    .recoverPublicKey(payload);
  const recoveredXy = recovered.toRawBytes(false).subarray(1);
  console.log(`  recovered pk: ${bytesToHex0x(recoveredXy)}`);
  check("recovered_pk == SigRequest.foreign_pk_xy",
    Buffer.from(recoveredXy).equals(Buffer.from(Uint8Array.from(sr.foreignPkXy))),
    "exactly what soda::finalize_signature checks on-chain via secp256k1_recover");
  check("recovered_pk == pubkey inside the Sui signature",
    Buffer.from(recovered.toRawBytes(true)).equals(Buffer.from(sig.publicKey)));

  // --- 6. Address derivation ---
  section("6", "Derive the Sui address from the recovered pubkey");
  const derivedAddr = bytesToHex0x(suiAddressFromPk(recovered.toRawBytes(false)));
  console.log(`  derived: ${derivedAddr}`);
  console.log(`  sender:  ${tx.sender}`);
  check("derived Sui address == tx sender", derivedAddr.toLowerCase() === tx.sender.toLowerCase(),
    "no private key for this address exists anywhere — only Solana program control");

  // --- 7. SODA-side derivation ---
  section("7", "Verify the address came from the SODA committee (re-derive from on-chain inputs)");
  const [committeePda] = PublicKey.findProgramAddressSync([Buffer.from("committee")], sodaProgram.programId);
  const committee = await (sodaProgram.account as any).committee.fetch(committeePda);
  const groupPkCompressed = Uint8Array.from(committee.groupPk);
  const onChainSeeds = Uint8Array.from(sr.derivationSeeds);
  const tweak = computeTweak(sr.requester.toBytes(), onChainSeeds, Uint8Array.from(sr.chainTag));
  const expectedForeignPk = deriveForeignPk(groupPkCompressed, tweak);
  console.log(`  group_pk:      ${bytesToHex0x(groupPkCompressed)}`);
  console.log(`  seeds:         ${onChainSeeds.length ? bytesToHex0x(onChainSeeds) : "(empty)"}  ${C.dim}(read from the on-chain SigRequest)${C.reset}`);
  console.log(`  tweak:         ${bytesToHex0x(tweak)}  ${C.dim}(sha256("SODA-v1" || requester || path || chain_tag))${C.reset}`);
  console.log(`  foreign_pk:    ${bytesToHex0x(compressPk(expectedForeignPk))}`);
  check("derived foreign_pk == on-chain SigRequest.foreign_pk_xy",
    Buffer.from(expectedForeignPk.subarray(1)).equals(Buffer.from(Uint8Array.from(sr.foreignPkXy))),
    "anyone can re-derive this address from the on-chain requester + path + chain tag, plus the committee's group_pk");

  // --- 8. Conclusion ---
  console.log(`\n${C.bold}${C.green}══════════════════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.green}  Conclusion${C.reset}`);
  console.log(`${C.bold}${C.green}══════════════════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`
  • The Sui transaction ${C.cyan}${digest}${C.reset}
    was signed by the secret key behind ${C.cyan}${tx.sender}${C.reset}.

  • That public key equals ${C.bold}group_pk + tweak·G${C.reset} where group_pk is the SODA
    committee's key and tweak is a hash of the requesting Solana account (+ path)
    + the "${CHAIN.key}" chain tag — so ${C.bold}only the SODA committee can produce
    signatures for ${tx.sender.slice(0, 18)}…${C.reset}, and only for payloads Solana recorded.

  • Solana validated this BEFORE Sui saw the transaction: SigRequest
    ${C.cyan}${sigRequestPda.toBase58()}${C.reset}
    was marked ${C.green}completed${C.reset} only after secp256k1_recover on Solana confirmed
    that (r,s) recovers to the program-derived foreign_pk_xy.

  ${C.bold}The "wallet" for this Sui address has no private key and lives nowhere
  except as a Solana account. Same primitive, second chain family.${C.reset}
`);
  console.log(`${C.dim}view on Solana Explorer (decodes anchor IXs by name):${C.reset}`);
  console.log(`  sig_request acct: ${explorerUrl(cluster, "account", sigRequestPda.toBase58())}`);
  console.log(`  committee acct:   ${explorerUrl(cluster, "account", committeePda.toBase58())}\n`);
}

main().catch((e) => {
  console.error(`${C.red}✗ verification failed:${C.reset}`, e?.message ?? e);
  process.exit(1);
});
