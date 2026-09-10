// SODA vault demo: a Solana PROGRAM owns an EVM address.
//
// Every other demo in this repo has a wallet own the foreign address. Here
// the owner is a PDA of the `vault_demo` program, and the program signs for
// it with `invoke_signed`. Two consequences the run makes visible:
//
//   1. The derived address is a function of the PDA, so it is a different
//      address from the one the same wallet owns in demo.ts. Nobody holds a
//      key for it and no human is in the loop.
//   2. The vault records one allowed recipient at creation and refuses to
//      sign a payment to anyone else. A key can always sign anything; this
//      address provably cannot pay a second counterparty. The run ends by
//      asking it to, and showing the refusal.
//
// Run: pnpm demo:vault      (DEMO_CHAIN=sepolia | base-sepolia)

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
  chainRpcUrl,
  computeTweak,
  deriveForeignPk,
  eip155V,
  encodeSignedLegacy,
  encodeUnsignedLegacy,
  ethAddressFromPk,
  EthRpc,
  getChain,
} from "@soda-sdk/core";

const CHAIN = getChain(process.env.DEMO_CHAIN);
const evm = new EthRpc(chainRpcUrl(CHAIN));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const SODA_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/soda.json");
const VAULT_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/vault_demo.json");
const SIGNER_KEY_PATH = resolve(REPO_ROOT, "keyshare.dev.json");

/** Which vault under this authority. Different id, different address. */
const VAULT_ID = BigInt(process.env.VAULT_ID ?? "0");
const TRANSFER_GAS_LIMIT = 21_000n;
const VALUE_WEI = 20_000_000_000_000n; // 0.00002 ETH, enough to see and cheap to lose
const FUNDING_THRESHOLD_WEI = 300_000_000_000_000n; // value + generous gas
const SPONSOR_MAX_TOPUP_WEI = 2_000_000_000_000_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bytesToHex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

function banner(line: string): void {
  const bar = "═".repeat(line.length + 4);
  console.log(`\n${bar}\n  ${line}\n${bar}\n`);
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

/** Top the vault's address up so a run does not stall on a faucet. */
async function fundFromSponsor(target: string, need: bigint): Promise<boolean> {
  const raw = process.env.SEPOLIA_FUNDER_KEY?.trim();
  if (!raw) return false;
  const sk = Uint8Array.from(Buffer.from(raw.replace(/^0x/, ""), "hex"));
  if (sk.length !== 32) {
    console.log("  ⚠ SEPOLIA_FUNDER_KEY is not a 32-byte hex key — skipping sponsor");
    return false;
  }
  const funder = bytesToHex(ethAddressFromPk(secp256k1.getPublicKey(sk, false)));
  const topUp = need > SPONSOR_MAX_TOPUP_WEI ? SPONSOR_MAX_TOPUP_WEI : need;
  const funderBal = await evm.getBalance(funder);
  const gasPrice = (await evm.getGasPrice()) * 2n;
  const cost = topUp + gasPrice * 21_000n;
  console.log(`  sponsor ${funder} (${(Number(funderBal) / 1e18).toFixed(6)} ETH)`);
  if (funderBal < cost) {
    console.log(`  ⚠ sponsor holds too little (${funderBal} wei < ${cost}) — fund the vault by hand`);
    return false;
  }
  const to = Uint8Array.from(Buffer.from(target.replace(/^0x/, ""), "hex"));
  const base = {
    nonce: await evm.getNonce(funder),
    gasPriceWei: gasPrice,
    gasLimit: 21_000n,
    to,
    valueWeiBe: bigintToBe(topUp, 16),
    data: new Uint8Array(0),
  };
  const sig = secp256k1.sign(keccak_256(encodeUnsignedLegacy({ ...base, chainId: CHAIN.chainId })), sk, {
    lowS: true,
  });
  const hash = await evm.sendRawTransaction(
    bytesToHex(
      encodeSignedLegacy(base, eip155V(sig.recovery!, CHAIN.chainId), bigintToBe(sig.r, 32), bigintToBe(sig.s, 32)),
    ),
  );
  console.log(`  → sponsored ${topUp} wei: ${CHAIN.explorerTx(hash)}`);
  for (let i = 0; i < 60; i++) {
    if ((await evm.getBalance(target).catch(() => 0n)) >= FUNDING_THRESHOLD_WEI) return true;
    await sleep(3_000);
  }
  return false;
}

async function main() {
  const DRY_RUN = process.env.SODA_DRY_RUN === "1";

  const walletKp = loadSolanaWallet();
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899", {
    commitment: "confirmed",
    ...(process.env.SOLANA_WS_URL ? { wsEndpoint: process.env.SOLANA_WS_URL } : {}),
  });
  const provider = new AnchorProvider(connection, new Wallet(walletKp), { commitment: "confirmed" });
  const sodaProgram = new Program(JSON.parse(readFileSync(SODA_IDL_PATH, "utf8")), provider);
  const vaultProgram = new Program(JSON.parse(readFileSync(VAULT_IDL_PATH, "utf8")), provider);

  banner("SODA vault — a Solana PROGRAM owns an EVM address");
  console.log(`Solana wallet:      ${walletKp.publicKey.toBase58()}  (${(
    (await connection.getBalance(walletKp.publicKey)) / LAMPORTS_PER_SOL
  ).toFixed(2)} SOL)`);
  console.log(`SODA program:       ${sodaProgram.programId.toBase58()}`);
  console.log(`vault_demo program: ${vaultProgram.programId.toBase58()}`);
  console.log(`chain:              ${CHAIN.name}`);

  // --- 1. Committee key ---
  const devSk = loadOrCreateSignerKey();
  const groupPkCompressed = secp256k1.getPublicKey(devSk, true);
  const [committeePda] = PublicKey.findProgramAddressSync([Buffer.from("committee")], sodaProgram.programId);
  const committee = await (sodaProgram.account as any).committee.fetch(committeePda);
  const onChain = Buffer.from(committee.groupPk).toString("hex");
  if (onChain !== Buffer.from(groupPkCompressed).toString("hex")) {
    throw new Error(`Committee group_pk mismatch.\n  on-chain: ${onChain}\n  local:    ${Buffer.from(groupPkCompressed).toString("hex")}`);
  }

  // --- 2. The vault PDA, and the two addresses it is worth comparing ---
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), walletKp.publicKey.toBuffer(), Buffer.from(bigintToBe(VAULT_ID, 8).reverse())],
    vaultProgram.programId,
  );
  const derivationSeeds = new Uint8Array(0);

  const addressOf = (owner: Uint8Array) =>
    bytesToHex(
      ethAddressFromPk(deriveForeignPk(groupPkCompressed, computeTweak(owner, derivationSeeds, CHAIN.chainTag))),
    );
  const vaultAddress = addressOf(vaultPda.toBytes());
  const walletAddress = addressOf(walletKp.publicKey.toBytes());

  // The recipient the vault is allowed to pay. Defaults to the address the
  // WALLET owns, so the vault can only ever pay its operator.
  const recipientHex = (process.env.VAULT_RECIPIENT?.trim() || walletAddress).toLowerCase();
  const recipient = Uint8Array.from(Buffer.from(recipientHex.replace(/^0x/, ""), "hex"));
  if (recipient.length !== 20) throw new Error(`VAULT_RECIPIENT must be 20 bytes: ${recipientHex}`);

  banner(`Vault PDA owns:  ${vaultAddress}`);
  console.log(`  vault PDA:        ${vaultPda.toBase58()}  (vault_id ${VAULT_ID})`);
  console.log(`  authority:        ${walletKp.publicKey.toBase58()}`);
  console.log(`  allowed payee:    ${recipientHex}`);
  console.log("");
  console.log(`  For contrast, the address the WALLET owns is ${walletAddress}.`);
  console.log("  Same committee, same chain, different owner, so a different address.");
  console.log(`  ${CHAIN.explorerAddress(vaultAddress)}`);

  // --- 3. Create the vault if it does not exist ---
  const existing = await connection.getAccountInfo(vaultPda);
  if (!existing) {
    console.log("\nCreating the vault on Solana...");
    const sig = await (vaultProgram.methods as any)
      .initVault(new BN(VAULT_ID.toString()), Array.from(recipient))
      .accounts({ authority: walletKp.publicKey, vault: vaultPda, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`  → init_vault tx: ${sig}`);
  } else {
    const v = await (vaultProgram.account as any).vault.fetch(vaultPda);
    const onChainRecipient = bytesToHex(Uint8Array.from(v.allowedRecipient));
    console.log(`\nVault exists. Allowed payee on-chain: ${onChainRecipient}`);
    if (onChainRecipient.toLowerCase() !== recipientHex) {
      throw new Error(
        `this vault is locked to ${onChainRecipient}, not ${recipientHex}. ` +
          `A vault's payee cannot be changed; use a different VAULT_ID for a different payee.`,
      );
    }
  }

  // --- 4. Fund the vault's address ---
  let balance = 0n;
  if (!DRY_RUN) {
    balance = await evm.getBalance(vaultAddress);
    console.log(`\n${CHAIN.name} balance of the vault's address: ${balance} wei`);
    if (balance < FUNDING_THRESHOLD_WEI) {
      const funded = await fundFromSponsor(vaultAddress, FUNDING_THRESHOLD_WEI - balance);
      if (!funded) {
        console.log(`\n→ Fund ${vaultAddress} with ~0.0003 ETH on ${CHAIN.name} and rerun.`);
        for (const f of CHAIN.faucets) console.log(`    ${f}`);
        return;
      }
      balance = await evm.getBalance(vaultAddress);
    }
    console.log(`✓ vault address holds ${balance} wei`);
  }

  // --- 5. Build the transfer the program will commit to ---
  const nonce = DRY_RUN ? BigInt(Math.floor(Math.random() * 0xffffffff)) : await evm.getNonce(vaultAddress);
  const MIN_GAS_PRICE = 2_000_000_000n;
  const fetched = DRY_RUN ? 10_000_000_000n : await evm.getGasPrice();
  const bumped = (fetched * 110n) / 100n;
  const gasPrice = bumped > MIN_GAS_PRICE ? bumped : MIN_GAS_PRICE;
  const valueWeiBe = bigintToBe(VALUE_WEI, 16);
  const base = { nonce, gasPriceWei: gasPrice, gasLimit: TRANSFER_GAS_LIMIT, to: recipient, valueWeiBe, data: new Uint8Array(0) };
  const payload = keccak_256(encodeUnsignedLegacy({ ...base, chainId: CHAIN.chainId }));

  console.log("\nTx the vault will authorise:");
  console.log(`  from:     ${vaultAddress}  (owned by the PDA)`);
  console.log(`  to:       ${recipientHex}  (the only address it may pay)`);
  console.log(`  value:    ${VALUE_WEI} wei`);
  console.log(`  payload:  ${bytesToHex(payload)}`);

  const rpc = (process.env.SOLANA_RPC_URL ?? "").toLowerCase();
  const cluster: "mainnet" | "devnet" | "local" = rpc.includes("devnet")
    ? "devnet"
    : rpc.includes("mainnet")
      ? "mainnet"
      : "local";
  const solscan = (s: string) =>
    cluster === "local" ? "(local validator — not on Solscan)" : `https://solscan.io/tx/${s}?cluster=${cluster}`;

  // --- 6. The program signs for its own PDA ---
  const [sigRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sig"), vaultPda.toBuffer(), Buffer.from(payload)],
    sodaProgram.programId,
  );

  console.log("\n[1/4] vault_demo::vault_sign_eth_transfer  (PDA is the requester, via invoke_signed)");
  const signTx = await (vaultProgram.methods as any)
    .vaultSignEthTransfer(
      Array.from(recipient),
      Array.from(valueWeiBe),
      new BN(nonce.toString()),
      new BN(gasPrice.toString()),
      new BN(CHAIN.chainId.toString()),
      Array.from(CHAIN.chainTag),
      Buffer.from(derivationSeeds),
    )
    .accounts({
      authority: walletKp.publicKey,
      vault: vaultPda,
      committee: committeePda,
      sigRequest: sigRequestPda,
      sodaProgram: sodaProgram.programId,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`      ✓ ${signTx}`);
  console.log(`      ↗ ${solscan(signTx)}`);

  // This is the assertion the whole exercise exists for: soda recorded the
  // PDA, not the wallet, as the owner of the foreign address.
  const sr = await (sodaProgram.account as any).sigRequest.fetch(sigRequestPda);
  const requester = new PublicKey(sr.requester);
  console.log(`      SigRequest.requester = ${requester.toBase58()}`);
  console.log(`      is the vault PDA:      ${requester.equals(vaultPda) ? "YES" : "NO"}`);
  console.log(`      is the wallet:         ${requester.equals(walletKp.publicKey) ? "YES" : "NO"}`);
  if (!requester.equals(vaultPda)) throw new Error("the requester is not the vault PDA — program ownership failed");

  // --- 7. Committee signs for the PDA's key ---
  const tweak = computeTweak(vaultPda.toBytes(), derivationSeeds, CHAIN.chainTag);
  const tweaked = (bytesToBigInt(devSk) + bytesToBigInt(tweak)) % secp256k1.CURVE.n;
  const sig = secp256k1.sign(payload, bigintToBe(tweaked, 32), { lowS: true });
  const sigBytes = sig.toCompactRawBytes();
  const recoveryId = sig.recovery!;

  console.log("\n[2/4] soda::finalize_signature  (secp256k1_recover verifies on-chain)");
  const finalizeTx = await (sodaProgram.methods as any)
    .finalizeSignature(Array.from(sigBytes), recoveryId)
    .accounts({ committee: committeePda, sigRequest: sigRequestPda, submitter: walletKp.publicKey })
    .rpc();
  console.log(`      ✓ ${finalizeTx}`);
  console.log(`      ↗ ${solscan(finalizeTx)}`);

  // --- 8. Broadcast ---
  const signedRlp = encodeSignedLegacy(
    base,
    eip155V(recoveryId, CHAIN.chainId),
    sigBytes.subarray(0, 32),
    sigBytes.subarray(32, 64),
  );
  if (DRY_RUN) {
    console.log("\n[dry-run] on-chain pipeline verified; skipping the broadcast.");
  } else {
    console.log(`\n[3/4] Broadcasting to ${CHAIN.name}...`);
    let hash: string;
    try {
      hash = await evm.sendRawTransaction(bytesToHex(signedRlp));
    } catch (e) {
      const m = (e as Error).message ?? "";
      if (!/already known|ALREADY_EXISTS|nonce too low/.test(m)) throw e;
      hash = "0x" + Buffer.from(keccak_256(signedRlp)).toString("hex");
      console.log("      (already broadcast — using the locally computed hash)");
    }
    console.log(`      ✓ ${CHAIN.explorerTx(hash)}`);
    try {
      writeFileSync(resolve(REPO_ROOT, ".last-tx-hash"), hash + "\n");
    } catch {
      /* non-fatal */
    }
  }

  // --- 9. The negative test: the rule is enforced, not advertised ---
  console.log("\n[4/4] Asking the vault to pay someone else (this must fail)");
  const intruder = Uint8Array.from(Buffer.from("00000000000000000000000000000000deadbeef", "hex"));
  const badPayload = keccak_256(
    encodeUnsignedLegacy({ ...base, to: intruder, nonce: nonce + 1n, chainId: CHAIN.chainId }),
  );
  const [badSigRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from("sig"), vaultPda.toBuffer(), Buffer.from(badPayload)],
    sodaProgram.programId,
  );
  try {
    await (vaultProgram.methods as any)
      .vaultSignEthTransfer(
        Array.from(intruder),
        Array.from(valueWeiBe),
        new BN((nonce + 1n).toString()),
        new BN(gasPrice.toString()),
        new BN(CHAIN.chainId.toString()),
        Array.from(CHAIN.chainTag),
        Buffer.from(derivationSeeds),
      )
      .accounts({
        authority: walletKp.publicKey,
        vault: vaultPda,
        committee: committeePda,
        sigRequest: badSigRequest,
        sodaProgram: sodaProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    throw new Error("the vault signed a payment to an address it should have refused");
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/RecipientNotAllowed|only pay the recipient/.test(msg)) {
      console.log("      ✓ refused: RecipientNotAllowed");
      console.log("        The authority asked and the program said no. No signature exists,");
      console.log("        so there is nothing to broadcast — the rule is on-chain, not in a client.");
    } else {
      throw new Error(`expected RecipientNotAllowed, got: ${msg}`);
    }
  }

  banner("DONE");
  console.log(`  The address ${vaultAddress}`);
  console.log(`  is owned by the Solana program ${vaultProgram.programId.toBase58()},`);
  console.log(`  through its PDA ${vaultPda.toBase58()}.`);
  console.log("  No key for it exists, no human approved the payment beyond triggering it,");
  console.log(`  and it can only ever pay ${recipientHex}.\n`);
  if (cluster !== "local") {
    console.log(`  verify:  VERIFY_REQUESTER=${vaultPda.toBase58()} pnpm verify <hash>\n`);
  }
}

main().catch((e) => {
  console.error("\n✗ vault demo failed:", e?.message ?? e);
  process.exit(1);
});
