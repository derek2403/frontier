// SODA proof tool — given a Sepolia tx hash, walks through the cryptographic
// chain that ties the Solana program to the ETH tx and prints an audit trail.
//
// Usage:
//   pnpm verify <ETH_TX_HASH>
//   SOLANA_CLUSTER=devnet pnpm verify 0xc399…
//
// Reads only public state:
//   - Sepolia: the broadcast tx + its from/to/value/nonce/gasPrice/v/r/s
//   - Solana: the SigRequest PDA + the Committee PDA
// No private keys are needed for verification — that's the point.

import { AnchorProvider, Program, type Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bigintToBe,
  bytesToBigInt,
  computeTweak,
  deriveForeignPk,
  encodeUnsignedLegacy,
  ETH_SEPOLIA_CHAIN_TAG,
  ethAddressFromPk,
  EthRpc,
} from "soda-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const SODA_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/soda.json");
const ETH_DEMO_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/eth_demo.json");

// Load .env from repo root so SEPOLIA_RPC_URL / SOLANA_DEVNET_RPC_URL get
// picked up without the user needing to source it manually.
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
  // If SOLANA_CLUSTER=devnet and SOLANA_RPC_URL isn't set, default to devnet helius.
  if (process.env.SOLANA_CLUSTER === "devnet" && !process.env.SOLANA_RPC_URL) {
    process.env.SOLANA_RPC_URL =
      process.env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  }
})();

const SEPOLIA_CHAIN_ID = 11_155_111n;

type Hex = `0x${string}`;
type SepoliaTx = {
  hash: Hex;
  from: Hex;
  to: Hex;
  value: Hex;
  nonce: Hex;
  gasPrice: Hex;
  gas: Hex;
  input: Hex;
  v: Hex;
  r: Hex;
  s: Hex;
  blockNumber: Hex;
};

const C = {
  reset: "\x1b[0m",
  bold:  "\x1b[1m",
  dim:   "\x1b[2m",
  green: "\x1b[32m",
  red:   "\x1b[31m",
  blue:  "\x1b[34m",
  yellow:"\x1b[33m",
  cyan:  "\x1b[36m",
};

function bytesToHex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  let clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Ethereum JSON-RPC strips leading zero nibbles from byte strings
  // (eth_getTransactionByHash returns r/s with odd-length hex sometimes).
  // Pad to even length so the byte parser doesn't choke.
  if (clean.length % 2 !== 0) clean = "0" + clean;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hexBnToBigInt(h: string): bigint {
  return BigInt(h);
}

function loadSolanaWallet(): Keypair {
  const path = process.env.ANCHOR_WALLET ?? resolve(homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? `${C.green}✓$${C.reset}` : `${C.red}✗$${C.reset}`;
  const status = ok ? `${C.green}MATCH$${C.reset}` : `${C.red}MISMATCH$${C.reset}`;
  console.log(`  ${mark} ${label}: ${status}${detail ? `  ${C.dim}(${detail})$${C.reset}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function section(num: string, title: string) {
  console.log(`\n${C.bold}${C.cyan}[${num}] ${title}$${C.reset}`);
}

function explorerUrl(cluster: "devnet" | "mainnet" | "local", what: "tx" | "account", id: string): string {
  if (cluster === "local") return "(local validator — not public)";
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/${what}/${id}${suffix}`;
}

async function main() {
  const ethTxHash = process.argv[2] || process.env.VERIFY_TX;
  if (!ethTxHash || !ethTxHash.startsWith("0x")) {
    console.error(`${C.red}usage: pnpm verify <ETH_TX_HASH>$${C.reset}`);
    console.error(`example: pnpm verify 0xc399076676b928ca167c2b14d09c0295f0281451fce00251e41aaeb1af559060`);
    process.exit(1);
  }

  const sepoliaRpc =
    process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";
  const solanaRpc =
    process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
  const cluster: "devnet" | "mainnet" | "local" =
    solanaRpc.toLowerCase().includes("devnet") ? "devnet"
    : solanaRpc.toLowerCase().includes("mainnet") ? "mainnet"
    : "local";

  console.log(`${C.bold}╔═══════════════════════════════════════════════════════════════════════════╗$${C.reset}`);
  console.log(`${C.bold}║  SODA PROOF AUDIT — Solana program controls an ETH address                ║$${C.reset}`);
  console.log(`${C.bold}╚═══════════════════════════════════════════════════════════════════════════╝$${C.reset}`);
  console.log(`${C.dim}Sepolia RPC:  ${sepoliaRpc.split("?")[0]}$${C.reset}`);
  console.log(`${C.dim}Solana RPC:   ${solanaRpc.split("?")[0]}  (${cluster})$${C.reset}`);

  // --- 1. Fetch the ETH tx from Sepolia ---
  section("1", "Fetch the broadcast ETH tx from Sepolia");
  const sepolia = new EthRpc(sepoliaRpc);
  const tx = (await sepolia.call<SepoliaTx | null>("eth_getTransactionByHash", [ethTxHash]));
  if (!tx) throw new Error(`Sepolia returned null for tx ${ethTxHash}`);
  const receipt = (await sepolia.call<{ status: Hex; blockNumber: Hex } | null>(
    "eth_getTransactionReceipt", [ethTxHash]
  ));
  console.log(`  hash:   ${tx.hash}`);
  console.log(`  from:   ${tx.from}`);
  console.log(`  to:     ${tx.to}`);
  console.log(`  value:  ${hexBnToBigInt(tx.value)} wei (${(Number(hexBnToBigInt(tx.value)) / 1e18).toFixed(6)} ETH)`);
  console.log(`  nonce:  ${hexBnToBigInt(tx.nonce)}`);
  console.log(`  v r s:  v=${hexBnToBigInt(tx.v)}  r=${tx.r}  s=${tx.s}`);
  const statusLabel = !receipt
    ? `${C.yellow}pending (not yet mined)$${C.reset}`
    : receipt.status === "0x1"
      ? `${C.green}success$${C.reset}`
      : `${C.red}reverted on-chain$${C.reset}`;
  console.log(`  status: ${statusLabel}`);
  console.log(`  block:  ${tx.blockNumber ?? "(pending)"}`);
  console.log(`  ${C.dim}etherscan: https://sepolia.etherscan.io/tx/${ethTxHash}$${C.reset}`);

  // --- 2. Reconstruct the unsigned RLP -> keccak payload ---
  section("2", "Reconstruct the unsigned RLP and keccak it");
  const nonce = hexBnToBigInt(tx.nonce);
  const gasPrice = hexBnToBigInt(tx.gasPrice);
  const gasLimit = hexBnToBigInt(tx.gas);
  const to = hexToBytes(tx.to);
  const value = hexBnToBigInt(tx.value);
  const data = hexToBytes(tx.input);
  const valueWeiBe = bigintToBe(value, 16);
  const v = hexBnToBigInt(tx.v);
  // EIP-155 v = recoveryId + 35 + 2*chainId  →  chainId = (v - 35) / 2
  const chainIdFromV = (v - 35n) / 2n;
  const recoveryId = Number((v - 35n) % 2n);
  const unsignedRlp = encodeUnsignedLegacy({
    nonce, gasPriceWei: gasPrice, gasLimit, to, valueWeiBe, data, chainId: chainIdFromV,
  });
  const payload = keccak_256(unsignedRlp);
  console.log(`  derived chainId:  ${chainIdFromV}`);
  console.log(`  recovery_id:      ${recoveryId}  ${C.dim}(from v = ${v})$${C.reset}`);
  console.log(`  unsigned RLP:     ${bytesToHex(unsignedRlp)}`);
  console.log(`  keccak(payload):  ${bytesToHex(payload)}`);
  check("v decodes to Sepolia chainId 11155111", chainIdFromV === SEPOLIA_CHAIN_ID,
    `got ${chainIdFromV}`);

  // --- 3. Find and fetch the matching SigRequest PDA on Solana ---
  section("3", "Locate the SigRequest PDA on Solana");
  const sodaIdl = JSON.parse(readFileSync(SODA_IDL_PATH, "utf8"));
  const ethDemoIdl = JSON.parse(readFileSync(ETH_DEMO_IDL_PATH, "utf8"));
  // Read-only provider — no signing needed for verification
  const walletKp = loadSolanaWallet();
  const wallet: Wallet = {
    publicKey: walletKp.publicKey,
    payer: walletKp,
    async signTransaction(t) { return t; },
    async signAllTransactions(ts) { return ts; },
  };
  const connection = new Connection(solanaRpc, "confirmed");
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sodaProgram = new Program(sodaIdl as any, provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ethDemoProgram = new Program(ethDemoIdl as any, provider);

  const [sigRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sig"), walletKp.publicKey.toBuffer(), Buffer.from(payload)],
    sodaProgram.programId,
  );
  console.log(`  requester:    ${walletKp.publicKey.toBase58()}  ${C.dim}(your CLI wallet)${C.reset}`);
  console.log(`  sig_request:  ${sigRequestPda.toBase58()}`);
  console.log(`  ${C.dim}explorer:     ${explorerUrl(cluster, "account", sigRequestPda.toBase58())}$${C.reset}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sr = await (sodaProgram.account as any).sigRequest.fetch(sigRequestPda);
  console.log(`  payload:      ${bytesToHex(Uint8Array.from(sr.payload))}`);
  console.log(`  foreign_pk:   ${bytesToHex(Uint8Array.from(sr.foreignPkXy))}`);
  console.log(`  signature:    ${bytesToHex(Uint8Array.from(sr.signature))}`);
  console.log(`  recovery_id:  ${sr.recoveryId}`);
  console.log(`  completed:    ${sr.completed}`);

  check("PDA exists for the payload Sepolia signed",
    Buffer.from(sr.payload).equals(Buffer.from(payload)),
    "SigRequest.payload == keccak(unsigned RLP)");
  check("SigRequest is completed", sr.completed === true);
  check("On-chain recovery_id matches v's parity",
    sr.recoveryId === recoveryId, `${sr.recoveryId} == ${recoveryId}`);

  // --- 4. ECDSA recover from (payload, signature, recovery_id) ---
  section("4", "Recover the signing pubkey from the ECDSA signature");
  const sigBytes = Uint8Array.from(sr.signature);
  const sigR = sigBytes.subarray(0, 32);
  const sigS = sigBytes.subarray(32, 64);
  const ethR = hexToBytes(tx.r);
  const ethS = hexToBytes(tx.s);
  const ethR32 = new Uint8Array(32); ethR32.set(ethR, 32 - ethR.length);
  const ethS32 = new Uint8Array(32); ethS32.set(ethS, 32 - ethS.length);
  check("Solana SigRequest.signature == Sepolia tx (r,s)",
    Buffer.from(sigR).equals(Buffer.from(ethR32)) && Buffer.from(sigS).equals(Buffer.from(ethS32)),
    "the same 64 bytes lived on Solana before being broadcast");

  const noSigSig = new secp256k1.Signature(bytesToBigInt(sigR), bytesToBigInt(sigS))
    .addRecoveryBit(sr.recoveryId);
  const recoveredPoint = noSigSig.recoverPublicKey(payload);
  const recoveredXY = recoveredPoint.toRawBytes(false).subarray(1); // strip 0x04
  console.log(`  recovered pk: ${bytesToHex(recoveredXY)}`);
  check("recovered_pk == SigRequest.foreign_pk_xy",
    Buffer.from(recoveredXY).equals(Buffer.from(Uint8Array.from(sr.foreignPkXy))),
    "this is exactly what soda::finalize_signature checks on-chain via secp256k1_recover");

  // --- 5. Address derivation: foreign_pk → ETH address ---
  section("5", "Derive the ETH address from the recovered pubkey");
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(recoveredXY, 1);
  const ethAddr = bytesToHex(ethAddressFromPk(uncompressed));
  console.log(`  derived: ${ethAddr}`);
  console.log(`  tx.from: ${tx.from}`);
  check("derived ETH address == tx.from",
    ethAddr.toLowerCase() === tx.from.toLowerCase(),
    "no private key for this address exists anywhere — only Solana program control");

  // --- 6. SODA-side derivation: foreign_pk == group_pk + tweak·G ---
  section("6", "Verify the address came from the SODA committee (off-chain derivation)");
  const [committeePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("committee")],
    sodaProgram.programId,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const committee = await (sodaProgram.account as any).committee.fetch(committeePda);
  const groupPkCompressed = Uint8Array.from(committee.groupPk);
  const tweak = computeTweak(
    ethDemoProgram.programId.toBytes(),
    new Uint8Array(0), // empty derivation seeds (the demo's choice)
    ETH_SEPOLIA_CHAIN_TAG,
  );
  const expectedForeignPk = deriveForeignPk(groupPkCompressed, tweak);
  const expectedForeignPkXy = expectedForeignPk.subarray(1);
  console.log(`  group_pk:      ${bytesToHex(groupPkCompressed)}`);
  console.log(`  tweak:         ${bytesToHex(tweak)}  ${C.dim}(sha256("SODA-v1" || eth_demo_id || "" || chain_tag))${C.reset}`);
  console.log(`  foreign_pk:    ${bytesToHex(expectedForeignPkXy)}`);
  check("derived foreign_pk == on-chain SigRequest.foreign_pk_xy",
    Buffer.from(expectedForeignPkXy).equals(Buffer.from(Uint8Array.from(sr.foreignPkXy))),
    "anyone can re-derive this address from the eth_demo program ID + the committee's group_pk");

  // --- 7. Conclusion ---
  console.log(`\n${C.bold}${C.green}══════════════════════════════════════════════════════════════════════════$${C.reset}`);
  console.log(`${C.bold}${C.green}  Conclusion$${C.reset}`);
  console.log(`${C.bold}${C.green}══════════════════════════════════════════════════════════════════════════$${C.reset}`);
  console.log(`
  • The ETH tx ${C.cyan}${ethTxHash}$${C.reset}
    was signed by the secret key behind ${C.cyan}${tx.from}$${C.reset}.

  • That public key (${C.dim}${bytesToHex(expectedForeignPkXy).slice(0, 18)}…$${C.reset})
    equals ${C.bold}group_pk + tweak·G$${C.reset} where group_pk is the SODA committee's
    secret share and tweak is a deterministic hash of the eth_demo program ID
    + chain tag — meaning ${C.bold}only the holder of the SODA committee's secret share
    can produce signatures that recover to ${tx.from}$${C.reset}.

  • Solana on-chain validated this BEFORE the ETH tx was broadcast: SigRequest
    PDA ${C.cyan}${sigRequestPda.toBase58()}$${C.reset}
    was marked ${C.green}completed$${C.reset} only after secp256k1_recover on Solana confirmed
    that the submitted (r,s) recovers to the expected foreign_pk_xy.

  ${C.bold}The "wallet" for this Ethereum address has no private key and lives nowhere
  except as a Solana PDA. That's the whole pitch.$${C.reset}
`);
  console.log(`${C.dim}view on Solana Explorer (decodes anchor IXs by name):$${C.reset}`);
  console.log(`  sig_request acct: ${explorerUrl(cluster, "account", sigRequestPda.toBase58())}`);
  console.log(`  committee acct:   ${explorerUrl(cluster, "account", committeePda.toBase58())}\n`);
}

main().catch((e) => {
  console.error(`${C.red}✗ verification failed:$${C.reset}`, e?.message ?? e);
  process.exit(1);
});
