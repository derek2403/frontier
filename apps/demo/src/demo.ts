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
  AAVE_DEPOSIT_GAS_LIMIT,
  AAVE_DEPOSIT_MIN_BALANCE_WEI,
  addressToBytes,
  chainRpcUrl,
  depositEthCalldata,
  getChain,
  bigintToBe,
  bytesToBigInt,
  computeTweak,
  deriveForeignPk,
  eip155V,
  encodeSignedLegacy,
  encodeUnsignedLegacy,
  ethAddressFromPk,
  EthRpc,
} from "@soda-sdk/core";

// DEMO_CHAIN selects the destination EVM chain (sepolia | base-sepolia).
// Must precede the RPC client, which is built from it at module init.
const CHAIN = getChain(process.env.DEMO_CHAIN);

const sepolia = new EthRpc(chainRpcUrl(CHAIN));
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const SODA_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/soda.json");
const ETH_DEMO_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/eth_demo.json");
const SIGNER_KEY_PATH = resolve(REPO_ROOT, "keyshare.dev.json");

const CHAIN_ID = CHAIN.chainId;
// The demo signs one thing: an Aave V3 depositETH call. The derived address
// ends up holding aWETH — a lending position owned by a Solana account.
// (The old self-transfer mode is gone; it proved the pipeline but said
// nothing about what the primitive is for.)
//
// Deposit + ~300k gas of headroom; the sponsor tops the address up to this.
const FUNDING_THRESHOLD_WEI = AAVE_DEPOSIT_MIN_BALANCE_WEI; // 0.0015 ETH
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


function bytesToHex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}

function banner(line: string): void {
  const bar = "═".repeat(line.length + 4);
  console.log(`\n${bar}\n  ${line}\n${bar}\n`);
}

/**
 * Top up a derived address from a sponsor key, so a run does not stall on a
 * human visiting a faucet.
 *
 * This is the demo-sized version of the production answer to the gas problem.
 * On Ethereum, gas is paid by the `from` account, and no third party can pay
 * on behalf of a plain EOA — so somebody has to put ETH at the derived
 * address before it can transact. Here that somebody is a key in .env; in
 * production it is a relayer that fronts the gas and charges the user in SOL.
 *
 * Deliberately capped: this key is a hot wallet sitting in a dotfile, so it
 * should only ever hold demo money, and a bug here should cost cents.
 */
const SPONSOR_MAX_TOPUP_WEI = 2_000_000_000_000_000n; // 0.002 ETH

async function fundFromSponsor(
  target: string,
  need: bigint,
): Promise<boolean> {
  const raw = process.env.SEPOLIA_FUNDER_KEY?.trim();
  if (!raw) return false;

  const sk = Uint8Array.from(Buffer.from(raw.replace(/^0x/, ""), "hex"));
  if (sk.length !== 32) {
    console.log("  ⚠ SEPOLIA_FUNDER_KEY is not a 32-byte hex key — skipping sponsor");
    return false;
  }

  const funderPk = secp256k1.getPublicKey(sk, false);
  const funder = bytesToHex(ethAddressFromPk(funderPk));

  const topUp = need > SPONSOR_MAX_TOPUP_WEI ? SPONSOR_MAX_TOPUP_WEI : need;
  const funderBal = await sepolia.getBalance(funder);
  const gasPrice = (await sepolia.getGasPrice()) * 2n;
  const gasLimit = 21_000n;
  const cost = topUp + gasPrice * gasLimit;

  console.log(`  sponsor ${funder} (${(Number(funderBal) / 1e18).toFixed(6)} ETH)`);
  if (funderBal < cost) {
    console.log(
      `  ⚠ sponsor balance ${funderBal} wei < ${cost} wei needed — falling back to faucet`,
    );
    return false;
  }

  const nonce = await sepolia.getNonce(funder);
  const unsigned = encodeUnsignedLegacy({
    nonce,
    gasPriceWei: gasPrice,
    gasLimit,
    to: Uint8Array.from(Buffer.from(target.replace(/^0x/, ""), "hex")),
    valueWeiBe: bigintToBe(topUp, 16),
    data: new Uint8Array(0),
    chainId: CHAIN_ID,
  });
  const sig = secp256k1.sign(keccak_256(unsigned), sk, { lowS: true });
  const signed = encodeSignedLegacy(
    {
      nonce,
      gasPriceWei: gasPrice,
      gasLimit,
      to: Uint8Array.from(Buffer.from(target.replace(/^0x/, ""), "hex")),
      valueWeiBe: bigintToBe(topUp, 16),
      data: new Uint8Array(0),
    },
    eip155V(sig.recovery!, CHAIN_ID),
    bigintToBe(sig.r, 32),
    bigintToBe(sig.s, 32),
  );

  const hash = await sepolia.sendRawTransaction(bytesToHex(signed));
  console.log(`  → sponsored ${topUp} wei: ${CHAIN.explorerTx(hash)}`);

  // Wait for the balance to actually move rather than for a receipt: the
  // balance is the thing the next step depends on.
  for (let i = 0; i < 60; i++) {
    const bal = await sepolia.getBalance(target).catch(() => 0n);
    if (bal >= FUNDING_THRESHOLD_WEI) {
      console.log(`  ✓ funded. balance: ${bal} wei`);
      return true;
    }
    await sleep(3_000);
  }
  console.log("  ⚠ sponsor tx did not land within 3 minutes");
  return false;
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
  // wsEndpoint is explicit because web3.js otherwise derives wss:// from the
  // HTTP URL, and some providers (Alchemy's Solana endpoint among them) reject
  // signatureSubscribe with -32601 — the transaction lands but confirmation
  // times out, which looks like a failed deploy.
  const connection = new Connection(
    process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899",
    {
      commitment: "confirmed",
      ...(process.env.SOLANA_WS_URL
        ? { wsEndpoint: process.env.SOLANA_WS_URL }
        : {}),
    },
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
  // Local devSk is only used when MPC_COORDINATOR_URL is unset (single-key
  // mode). In MPC mode, group_pk comes from the on-chain Committee.
  const MPC_MODE = !!process.env.MPC_COORDINATOR_URL;
  const devSk = MPC_MODE ? new Uint8Array(32) : loadOrCreateSignerKey();
  let groupPkCompressed = MPC_MODE
    ? new Uint8Array(33)
    : secp256k1.getPublicKey(devSk, true);

  const [committeePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("committee")],
    sodaProgram.programId,
  );

  const committeeAcct = await connection.getAccountInfo(committeePda);
  if (!committeeAcct) {
    if (MPC_MODE) {
      throw new Error(
        "MPC mode requires an existing Committee PDA. Run `pnpm mpc:update-committee` after DKG.",
      );
    }
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
    if (MPC_MODE) {
      // Trust the on-chain key (it was set by update_committee from DKG output).
      groupPkCompressed = Uint8Array.from(Buffer.from(onChain, "hex"));
      console.log(`  group_pk (on-chain, MPC):  ${onChain}`);
    } else {
      const local = Buffer.from(groupPkCompressed).toString("hex");
      if (onChain !== local) {
        throw new Error(
          `Committee group_pk mismatch.\n  on-chain: ${onChain}\n  local:    ${local}\n` +
            `Either delete ${SIGNER_KEY_PATH} and rerun, or set MPC_COORDINATOR_URL to use MPC mode.`,
        );
      }
    }
  }

  // --- 2. Derive ETH address ---
  // The tweak is keyed on the OWNER (the signer), matching what the program
  // now computes on-chain. `derivationSeeds` is the path: it lets one owner
  // hold several foreign addresses. Empty = the owner's default account.
  //
  // This mirrors NEAR: tweak = H(domain, predecessor_account, path). The
  // owner slot used to hold the eth_demo program id and the path slot was
  // empty, which is why every caller landed on the same address.
  const derivationSeeds = new Uint8Array(0);
  const tweak = computeTweak(
    walletKp.publicKey.toBytes(),
    derivationSeeds,
    CHAIN.chainTag,
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
      const sponsored = await fundFromSponsor(
        ethAddress,
        FUNDING_THRESHOLD_WEI - balance,
      );
      if (sponsored) {
        balance = await sepolia.getBalance(ethAddress);
      } else {
        console.log("\n→ Fund the address above with ~0.001 Sepolia ETH:");
        console.log("    (or set SEPOLIA_FUNDER_KEY in .env to auto-fund)");
        console.log("    https://www.alchemy.com/faucets/ethereum-sepolia");
        console.log("    https://sepoliafaucet.com/");
        console.log("    https://faucet.quicknode.com/ethereum/sepolia\n");
        console.log("Polling for funding (will resume automatically)...");
        balance = await pollForFunding(ethAddress);
      }
      console.log(`✓ Funded. Balance: ${balance} wei\n`);
    }
  } else {
    console.log("[dry-run] skipping Sepolia funding gate");
  }

  // --- 4. Build the unsigned tx ---

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

  if (!CHAIN.aave) {
    throw new Error(`${CHAIN.name} has no Aave V3 deployment configured`);
  }
  // `to` is the gateway; `onBehalfOf` inside the calldata is the DERIVED
  // address, so the aWETH lands at the Solana-controlled account.
  const txTo = addressToBytes(CHAIN.aave.WETH_GATEWAY);
  const txData = depositEthCalldata(CHAIN.aave, ethAddressFromPk(foreignPk));
  const gasLimit = AAVE_DEPOSIT_GAS_LIMIT;
  const txToHex = bytesToHex(txTo);

  console.log("Tx:");
  console.log(`  chain:     ${CHAIN.name} (chainId ${CHAIN_ID})`);
  console.log(`  action:    Aave V3 depositETH → aWETH to ${ethAddress}`);
  console.log(`  to:        ${txToHex}  (WrappedTokenGatewayV3)`);
  console.log(`  data:      ${bytesToHex(txData).slice(0, 10)}… (${txData.length} bytes)`);
  console.log(`  value:     ${VALUE_WEI} wei (0.0001 ETH)`);
  console.log(`  nonce:     ${nonce}`);
  console.log(`  gasPrice:  ${gasPrice} wei`);
  console.log(`  gasLimit:  ${gasLimit}`);

  const unsignedRlp = encodeUnsignedLegacy({
    nonce,
    gasPriceWei: gasPrice,
    gasLimit,
    to: txTo,
    valueWeiBe,
    data: txData,
    chainId: CHAIN_ID,
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
      Array.from(txTo),
      Array.from(valueWeiBe),
      new BN(nonce.toString()),
      new BN(gasPrice.toString()),
      new BN(gasLimit.toString()),
      Buffer.from(txData),
      new BN(CHAIN_ID.toString()),
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
    .rpc();
  console.log(`      ✓ ${signTxSig}`);
  console.log(`      ↗ ${solscanTx(signTxSig)}`);

  // --- 6. Off-chain signing — AWS MPC committee if configured, else local k256. ---
  const MPC_URL = process.env.MPC_COORDINATOR_URL?.replace(/\/+$/, "");
  const MPC_TOKEN = process.env.MPC_COORDINATOR_TOKEN;
  let sigBytes: Uint8Array;
  let recoveryId: number;
  if (MPC_URL) {
    console.log(`\n[*] sign via MPC committee  ${MPC_URL}/sign`);
    const res = await fetch(`${MPC_URL}/sign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(MPC_TOKEN ? { authorization: `Bearer ${MPC_TOKEN}` } : {}),
      },
      // The committee reads the request from chain itself; we only name it.
      body: JSON.stringify({ sigRequestPubkey: sigRequestPda.toBase58() }),
    });
    if (!res.ok) {
      throw new Error(`mpc coordinator ${res.status}: ${await res.text()}`);
    }
    const sig = (await res.json()) as { r: string; s: string; v: number };
    sigBytes = Buffer.concat([Buffer.from(sig.r, "hex"), Buffer.from(sig.s, "hex")]);
    recoveryId = sig.v;
    console.log(`      ✓ Lindell '17 2-of-2 signature, recovery_id=${recoveryId}`);
  } else {
    const skBig = bytesToBigInt(devSk);
    const tweakBig = bytesToBigInt(tweak);
    const tweakedSkBig = (skBig + tweakBig) % secp256k1.CURVE.n;
    if (tweakedSkBig === 0n) throw new Error("tweaked sk is zero");
    const tweakedSk = bigintToBe(tweakedSkBig, 32);
    const sig = secp256k1.sign(payload, tweakedSk, { lowS: true });
    sigBytes = sig.toCompactRawBytes();
    recoveryId = sig.recovery!;
  }

  // Local mirror of the on-chain check: recover from (payload, sig, recovery_id)
  // and compare to the foreign_pk we committed to. If this disagrees, the bug is
  // off-chain and we can say so before burning a transaction.
  {
    const recPt = secp256k1.Signature.fromCompact(sigBytes)
      .addRecoveryBit(recoveryId)
      .recoverPublicKey(payload);
    const recXy = recPt.toRawBytes(false).subarray(1);
    const ok = Buffer.from(recXy).equals(Buffer.from(foreignPkXy));
    console.log(`      local recover check: ${ok ? "MATCH" : "MISMATCH"}`);
    if (!ok) {
      console.log(`        recovered:   ${bytesToHex(recXy).slice(0, 34)}…`);
      console.log(`        foreign_pk:  ${bytesToHex(foreignPkXy).slice(0, 34)}…`);
    }
  }

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
  const v = eip155V(recoveryId, CHAIN_ID);
  const signedRlp = encodeSignedLegacy(
    {
      nonce,
      gasPriceWei: gasPrice,
      gasLimit,
      to: txTo,
      valueWeiBe,
      data: txData,
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


  banner("DONE — open these in a browser:");
  console.log(`  ETH side (${CHAIN.name}):  ${CHAIN.explorerTx(ethTxHash)}`);
  if (solanaCluster !== "local") {
    console.log(`  Solana side (${solanaCluster}):  ${solscanTx(signTxSig)}`);
    console.log(`                          ${solscanTx(finalSig)}`);
  }
  console.log("");
  console.log(`  from:   ${ethAddress}  (derived from your Solana wallet)`);
  console.log(`  to:     ${txToHex}  (Aave WrappedTokenGatewayV3)`);
  console.log(`  value:  0.0001 ETH deposited → aWETH`);
  console.log(`  aWETH:  ${CHAIN.explorerToken(CHAIN.aave!.A_WETH, ethAddress)}`);
  console.log(`  hash:  ${ethTxHash}\n`);
}

main().catch((e) => {
  console.error("\n✗ demo failed:", e?.message ?? e);
  process.exit(1);
});
