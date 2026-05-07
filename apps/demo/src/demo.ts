// SODA end-to-end demo: a Solana program signs an Ethereum transaction.
//
// One-shot script. Prints what's happening, polls for ETH funding so it
// resumes automatically once the address is funded, ends with an Etherscan
// link to click.

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bigintToBe,
  bytesToBigInt,
  computeTweak,
  deriveForeignPk,
  eip155V,
  encodeSignedLegacy,
  encodeUnsignedLegacy,
  ETH_SEPOLIA_CHAIN_TAG,
  ethAddressFromPk,
  EthRpc,
} from "soda-sdk";

const sepolia = new EthRpc(
  process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org",
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const SODA_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/soda.json");
const ETH_DEMO_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/eth_demo.json");
const SIGNER_KEY_PATH = resolve(REPO_ROOT, "keyshare.dev.json");

const SEPOLIA_CHAIN_ID = 11_155_111n;
const FUNDING_THRESHOLD_WEI = 200_000_000_000_000n; // 0.0002 ETH; covers value + gas
const VALUE_WEI = 100_000_000_000_000n; // 0.0001 ETH per demo run

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`bad hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}

function banner(line: string): void {
  const bar = "═".repeat(line.length + 4);
  console.log(`\n${bar}\n  ${line}\n${bar}\n`);
}

async function pollForFunding(addr: string): Promise<bigint> {
  let last = -1n;
  while (true) {
    const bal = await sepolia.getBalance(addr).catch(() => 0n);
    if (bal !== last) {
      process.stdout.write(`\r  current balance: ${bal} wei         `);
      last = bal;
    }
    if (bal >= FUNDING_THRESHOLD_WEI) {
      process.stdout.write("\n");
      return bal;
    }
    await sleep(8_000);
  }
}

async function main() {
  const DRY_RUN = process.env.SODA_DRY_RUN === "1";

  // --- Setup ---
  const walletKp = loadSolanaWallet();
  const wallet = new Wallet(walletKp);
  const connection = new Connection(
    process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899",
    "confirmed",
  );
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const sodaIdl = JSON.parse(readFileSync(SODA_IDL_PATH, "utf8"));
  const ethDemoIdl = JSON.parse(readFileSync(ETH_DEMO_IDL_PATH, "utf8"));
  const sodaProgram = new Program(sodaIdl, provider);
  const ethDemoProgram = new Program(ethDemoIdl, provider);

  const lamports = await connection.getBalance(walletKp.publicKey);
  const solBal = (lamports / LAMPORTS_PER_SOL).toFixed(2);

  banner("SODA demo — a Solana program signs an Ethereum transaction");

  console.log(`Solana wallet:     ${walletKp.publicKey.toBase58()}  (${solBal} SOL)`);
  console.log(`SODA program:      ${sodaProgram.programId.toBase58()}`);
  console.log(`eth_demo program:  ${ethDemoProgram.programId.toBase58()}`);

  // --- 1. Dev signer key + committee init ---
  const devSk = loadOrCreateSignerKey();
  const groupPkCompressed = secp256k1.getPublicKey(devSk, true);

  const [committeePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("committee")],
    sodaProgram.programId,
  );

  const committeeAcct = await connection.getAccountInfo(committeePda);
  if (!committeeAcct) {
    console.log("\nInitializing SODA committee on Solana...");
    const sig = await (sodaProgram.methods as any)
      .initCommittee(Array.from(groupPkCompressed))
      .accounts({
        committee: committeePda,
        authority: walletKp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  → init_committee tx: ${sig}`);
  } else {
    const committee = await (sodaProgram.account as any).committee.fetch(committeePda);
    const onChain = Buffer.from(committee.groupPk).toString("hex");
    const local = Buffer.from(groupPkCompressed).toString("hex");
    if (onChain !== local) {
      throw new Error(
        `Committee group_pk mismatch.\n  on-chain: ${onChain}\n  local:    ${local}\n` +
          `Either delete ${SIGNER_KEY_PATH} and rerun, or restart validator with --reset.`,
      );
    }
  }

  // --- 2. Derive ETH address ---
  const derivationSeeds = new Uint8Array(0);
  const tweak = computeTweak(
    ethDemoProgram.programId.toBytes(),
    derivationSeeds,
    ETH_SEPOLIA_CHAIN_TAG,
  );
  const foreignPk = deriveForeignPk(groupPkCompressed, tweak);
  const ethAddress = bytesToHex(ethAddressFromPk(foreignPk));

  banner(`Solana-derived ETH address:  ${ethAddress}`);

  // --- 3. Funding (auto-poll) ---
  let balance = 0n;
  if (!DRY_RUN) {
    balance = await sepolia.getBalance(ethAddress);
    console.log(`Current Sepolia balance: ${balance} wei (${(Number(balance) / 1e18).toFixed(6)} ETH)`);
    if (balance < FUNDING_THRESHOLD_WEI) {
      console.log("\n→ Fund the address above with ~0.001 Sepolia ETH:");
      console.log("    https://www.alchemy.com/faucets/ethereum-sepolia");
      console.log("    https://sepoliafaucet.com/");
      console.log("    https://faucet.quicknode.com/ethereum/sepolia\n");
      console.log("Polling for funding (will resume automatically)...");
      balance = await pollForFunding(ethAddress);
      console.log(`✓ Funded. Balance: ${balance} wei\n`);
    }
  } else {
    console.log("[dry-run] skipping Sepolia funding gate");
  }

  // --- 4. Build the unsigned tx ---
  // Default: self-transfer (recipient = derived ETH address) so each demo only
  // costs gas, value bounces back. Override with DEMO_RECIPIENT to send elsewhere.
  const recipientHex = process.env.DEMO_RECIPIENT?.trim() || ethAddress;
  const recipient = hexToBytes(recipientHex);
  if (recipient.length !== 20) throw new Error(`recipient must be 20 bytes: ${recipientHex}`);

  // SODA_OVERRIDE_NONCE lets you replace a stuck-pending tx by re-using its
  // nonce with a higher gas price (Sepolia's "replacement transaction" rule).
  const overrideNonceStr = process.env.SODA_OVERRIDE_NONCE?.trim();
  const nonce = DRY_RUN
    ? BigInt(Math.floor(Math.random() * 0xffffffff))
    : overrideNonceStr
      ? BigInt(overrideNonceStr)
      : await sepolia.getNonce(ethAddress);
  // Sepolia's eth_gasPrice can return absurdly low values (saw 0.001 gwei
  // returned by Alchemy in quiet periods), and a tx priced that low sits
  // in mempool forever. Bump 110% over the suggested price with a 2 gwei floor.
  const MIN_GAS_PRICE = 2_000_000_000n; // 2 gwei
  const fetchedGasPrice = DRY_RUN ? 10_000_000_000n : await sepolia.getGasPrice();
  const bumpedGasPrice = (fetchedGasPrice * 110n) / 100n;
  const gasPrice = bumpedGasPrice > MIN_GAS_PRICE ? bumpedGasPrice : MIN_GAS_PRICE;
  const valueWeiBe = bigintToBe(VALUE_WEI, 16);
  const gasLimit = 21_000n;

  console.log("Tx:");
  console.log(`  to:        ${recipientHex}`);
  console.log(`  value:     ${VALUE_WEI} wei (0.0001 ETH)`);
  console.log(`  nonce:     ${nonce}`);
  console.log(`  gasPrice:  ${gasPrice} wei`);
  console.log(`  gasLimit:  ${gasLimit}`);

  const unsignedRlp = encodeUnsignedLegacy({
    nonce,
    gasPriceWei: gasPrice,
    gasLimit,
    to: recipient,
    valueWeiBe,
    data: new Uint8Array(0),
    chainId: SEPOLIA_CHAIN_ID,
  });
  const payload = keccak_256(unsignedRlp);
  console.log(`  payload:   ${bytesToHex(payload)}`);

  // --- 5. Solana: eth_demo::sign_eth_transfer (CPIs request_signature) ---
  const [sigRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sig"), walletKp.publicKey.toBuffer(), Buffer.from(payload)],
    sodaProgram.programId,
  );
  const foreignPkXy = foreignPk.subarray(1);

  // Detect public Solana cluster from RPC URL so we can print Solscan links.
  const rpc = (process.env.SOLANA_RPC_URL ?? "").toLowerCase();
  const solanaCluster: "mainnet" | "devnet" | "local" =
    rpc.includes("devnet") ? "devnet"
    : rpc.includes("mainnet") ? "mainnet"
    : "local";
  const solscanTx = (sig: string) =>
    solanaCluster === "local"
      ? `(local validator — not on Solscan)`
      : `https://solscan.io/tx/${sig}${solanaCluster === "devnet" ? "?cluster=devnet" : ""}`;

  console.log("\n[1/3] eth_demo::sign_eth_transfer  (Solana program builds RLP, CPIs SODA)");
  const signTxSig = await (ethDemoProgram.methods as any)
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
      user: walletKp.publicKey,
      committee: committeePda,
      sigRequest: sigRequestPda,
      sodaProgram: sodaProgram.programId,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`      ✓ ${signTxSig}`);
  console.log(`      ↗ ${solscanTx(signTxSig)}`);

  // --- 6. Off-chain: k256 sign with tweaked SK ---
  const skBig = bytesToBigInt(devSk);
  const tweakBig = bytesToBigInt(tweak);
  const tweakedSkBig = (skBig + tweakBig) % secp256k1.CURVE.n;
  if (tweakedSkBig === 0n) throw new Error("tweaked sk is zero");
  const tweakedSk = bigintToBe(tweakedSkBig, 32);

  const sig = secp256k1.sign(payload, tweakedSk, { lowS: true });
  const sigBytes = sig.toCompactRawBytes();
  const recoveryId = sig.recovery!;

  // --- 7. Solana: soda::finalize_signature (on-chain secp256k1_recover) ---
  console.log("\n[2/3] soda::finalize_signature  (on-chain secp256k1_recover verifies)");
  const finalSig = await (sodaProgram.methods as any)
    .finalizeSignature(Array.from(sigBytes), recoveryId)
    .accounts({
      committee: committeePda,
      sigRequest: sigRequestPda,
      submitter: walletKp.publicKey,
    })
    .rpc();
  console.log(`      ✓ ${finalSig}`);
  console.log(`      ↗ ${solscanTx(finalSig)}`);

  const sigRequest = await (sodaProgram.account as any).sigRequest.fetch(sigRequestPda);
  if (!sigRequest.completed) throw new Error("SigRequest still incomplete");

  // --- 8. Assemble + broadcast ---
  const v = eip155V(recoveryId, SEPOLIA_CHAIN_ID);
  const signedRlp = encodeSignedLegacy(
    {
      nonce,
      gasPriceWei: gasPrice,
      gasLimit,
      to: recipient,
      valueWeiBe,
      data: new Uint8Array(0),
    },
    v,
    sigBytes.subarray(0, 32),
    sigBytes.subarray(32, 64),
  );
  const signedHex = bytesToHex(signedRlp);

  if (DRY_RUN) {
    console.log("\n[dry-run] On-chain pipeline verified. Skipping Sepolia broadcast.");
    console.log(`Signed RLP: ${signedHex}`);
    return;
  }

  console.log("\n[3/3] Broadcasting to Sepolia...");
  // The ETH tx hash is keccak256 of the signed RLP — deterministic, so we
  // can compute it ourselves. We attempt the broadcast; if a relayer (or any
  // other observer) already submitted the same signed RLP, Sepolia will
  // reply "already known" and we just keep our precomputed hash.
  const computedHash = "0x" + Buffer.from(keccak_256(signedRlp)).toString("hex");
  let ethTxHash: string;
  try {
    ethTxHash = await sepolia.sendRawTransaction(signedHex);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (
      msg.includes("already known") ||
      msg.includes("ALREADY_EXISTS") ||
      msg.includes("nonce too low")
    ) {
      console.log("      (already broadcast by relayer — using local hash)");
      ethTxHash = computedHash;
    } else {
      throw e;
    }
  }

  // Persist the latest ETH tx hash so demo.sh can hand it to `pnpm verify`.
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resolve(REPO_ROOT, ".last-tx-hash"), ethTxHash + "\n");
  } catch {
    /* non-fatal */
  }

  const isSelfTransfer = recipientHex.toLowerCase() === ethAddress.toLowerCase();

  banner("DONE — open these in a browser:");
  console.log(`  ETH side (Sepolia):    https://sepolia.etherscan.io/tx/${ethTxHash}`);
  if (solanaCluster !== "local") {
    console.log(`  Solana side (${solanaCluster}):  ${solscanTx(signTxSig)}`);
    console.log(`                          ${solscanTx(finalSig)}`);
  }
  console.log("");
  console.log(`  from:  ${ethAddress}  (controlled by Solana, no private key)`);
  console.log(`  to:    ${recipientHex}${isSelfTransfer ? "  (self-transfer)" : ""}`);
  console.log(`  value: 0.0001 ETH`);
  console.log(`  hash:  ${ethTxHash}\n`);
}

main().catch((e) => {
  console.error("\n✗ demo failed:", e?.message ?? e);
  process.exit(1);
});
