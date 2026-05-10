// Server-only. Mirrors apps/demo/src/demo.ts but as an async function with an
// onEvent listener so the API route can stream progress over SSE.

import { AnchorProvider, Program, type Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

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
import { ethDemoIdl, sodaIdl } from "./idls";

const REPO_ROOT = resolve(process.cwd(), "../..");
const SIGNER_KEY_PATH = resolve(REPO_ROOT, "keyshare.dev.json");

const SEPOLIA_CHAIN_ID = 11_155_111n;
const FUNDING_THRESHOLD_WEI = 200_000_000_000_000n;
const VALUE_WEI = 100_000_000_000_000n;

function sepoliaRpc(): string {
  return (
    process.env.SEPOLIA_RPC_URL ??
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ??
    "https://rpc.sepolia.org"
  );
}

function solanaRpc(): string {
  return (
    process.env.SOLANA_RPC_URL ??
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
    "http://127.0.0.1:8899"
  );
}

export type StepName =
  | "signEthTransfer"
  | "sigRequested"
  | "signOffChain"
  | "finalizeOnChain"
  | "broadcastEth";

export type StepStatus = "active" | "done" | "error";

export type RunEvent =
  | { kind: "step"; name: StepName; status: StepStatus; data?: unknown }
  | { kind: "log"; message: string };

export type RunResult = {
  ethAddress: string;
  recipient: string;
  isSelfTransfer: boolean;
  signedHex: string;
  ethTxHash: string;
  signEthTransferTx: string;
  finalizeSignatureTx: string;
  payloadHex: string;
};

function loadOrCreateSignerKey(): Uint8Array {
  if (existsSync(SIGNER_KEY_PATH)) {
    return Uint8Array.from(
      Buffer.from(readFileSync(SIGNER_KEY_PATH, "utf8").trim(), "hex"),
    );
  }
  const sk = secp256k1.utils.randomPrivateKey();
  writeFileSync(SIGNER_KEY_PATH, Buffer.from(sk).toString("hex"), { mode: 0o600 });
  return sk;
}

function loadSolanaWallet(): Keypair {
  const path =
    process.env.ANCHOR_WALLET ?? resolve(homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
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

function makeSepolia(): EthRpc {
  return new EthRpc(sepoliaRpc());
}

export async function runDemo(
  recipientHexOrUndef: string | undefined,
  onEvent: (e: RunEvent) => void,
): Promise<RunResult> {
  const walletKp = loadSolanaWallet();
  const connection = new Connection(solanaRpc(), "confirmed");
  const wallet: Wallet = {
    publicKey: walletKp.publicKey,
    payer: walletKp,
    async signTransaction(tx) {
      if ("partialSign" in tx) tx.partialSign(walletKp);
      else tx.sign([walletKp]);
      return tx;
    },
    async signAllTransactions(txs) {
      for (const tx of txs) {
        if ("partialSign" in tx) tx.partialSign(walletKp);
        else tx.sign([walletKp]);
      }
      return txs;
    },
  };
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sodaProgram = new Program(sodaIdl as any, provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ethDemoProgram = new Program(ethDemoIdl as any, provider);

  // 1. Dev signer + committee init (silent — happens before any step events)
  const devSk = loadOrCreateSignerKey();
  const groupPkCompressed = secp256k1.getPublicKey(devSk, true);

  const [committeePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("committee")],
    sodaProgram.programId,
  );

  const committeeAcct = await connection.getAccountInfo(committeePda);
  if (!committeeAcct) {
    onEvent({ kind: "log", message: "Initializing committee..." });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sodaProgram.methods as any)
      .initCommittee(Array.from(groupPkCompressed))
      .accounts({
        committee: committeePda,
        authority: walletKp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const committee = await (sodaProgram.account as any).committee.fetch(
      committeePda,
    );
    const onChain = Buffer.from(committee.groupPk).toString("hex");
    const local = Buffer.from(groupPkCompressed).toString("hex");
    if (onChain !== local) {
      throw new Error(
        `Committee group_pk mismatch.\n  on-chain: ${onChain}\n  local:    ${local}\n` +
          `Delete ${SIGNER_KEY_PATH} and rerun, or restart validator with --reset.`,
      );
    }
  }

  // 2. Derive ETH address
  const derivationSeeds = new Uint8Array(0);
  const tweak = computeTweak(
    ethDemoProgram.programId.toBytes(),
    derivationSeeds,
    ETH_SEPOLIA_CHAIN_TAG,
  );
  const foreignPk = deriveForeignPk(groupPkCompressed, tweak);
  const ethAddress = bytesToHex(ethAddressFromPk(foreignPk));

  // 3. Funding check
  const sepolia = makeSepolia();
  const balance = await sepolia.getBalance(ethAddress);
  if (balance < FUNDING_THRESHOLD_WEI) {
    throw new Error(
      `Sepolia balance ${balance} wei is below funding threshold. ` +
        `Fund ${ethAddress} with ~0.001 Sepolia ETH and try again.`,
    );
  }

  // 4. Build unsigned tx
  const recipientHex = recipientHexOrUndef?.trim() || ethAddress;
  const recipient = hexToBytes(recipientHex);
  if (recipient.length !== 20) {
    throw new Error(`recipient must be 20 bytes: ${recipientHex}`);
  }
  const isSelfTransfer = recipientHex.toLowerCase() === ethAddress.toLowerCase();

  const nonce = await sepolia.getNonce(ethAddress);
  // Floor + bump in case eth_gasPrice returns an unusably low number on a
  // quiet Sepolia (we saw 0.001 gwei from Alchemy; tx sat in mempool forever).
  const MIN_GAS_PRICE = 2_000_000_000n; // 2 gwei
  const fetchedGasPrice = await sepolia.getGasPrice();
  const bumpedGasPrice = (fetchedGasPrice * 110n) / 100n;
  const gasPrice =
    bumpedGasPrice > MIN_GAS_PRICE ? bumpedGasPrice : MIN_GAS_PRICE;
  const valueWeiBe = bigintToBe(VALUE_WEI, 16);
  const gasLimit = 21_000n;

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

  // 5. eth_demo::sign_eth_transfer
  const [sigRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sig"), walletKp.publicKey.toBuffer(), Buffer.from(payload)],
    sodaProgram.programId,
  );
  const foreignPkXy = foreignPk.subarray(1);

  onEvent({ kind: "step", name: "signEthTransfer", status: "active" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signEthTransferTx = await (ethDemoProgram.methods as any)
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
  onEvent({
    kind: "step",
    name: "signEthTransfer",
    status: "done",
    data: { txSig: signEthTransferTx },
  });
  onEvent({ kind: "step", name: "sigRequested", status: "done" });

  // 6. Off-chain k256 sign with tweaked SK
  onEvent({ kind: "step", name: "signOffChain", status: "active" });
  const skBig = bytesToBigInt(devSk);
  const tweakBig = bytesToBigInt(tweak);
  const tweakedSkBig = (skBig + tweakBig) % secp256k1.CURVE.n;
  if (tweakedSkBig === 0n) throw new Error("tweaked sk is zero");
  const tweakedSk = bigintToBe(tweakedSkBig, 32);
  const sig = secp256k1.sign(payload, tweakedSk, { lowS: true });
  const sigBytes = sig.toCompactRawBytes();
  const recoveryId = sig.recovery!;
  onEvent({
    kind: "step",
    name: "signOffChain",
    status: "done",
    data: { recoveryId },
  });

  // 7. soda::finalize_signature
  onEvent({ kind: "step", name: "finalizeOnChain", status: "active" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finalizeSignatureTx = await (sodaProgram.methods as any)
    .finalizeSignature(Array.from(sigBytes), recoveryId)
    .accounts({
      committee: committeePda,
      sigRequest: sigRequestPda,
      submitter: walletKp.publicKey,
    })
    .rpc();
  onEvent({
    kind: "step",
    name: "finalizeOnChain",
    status: "done",
    data: { txSig: finalizeSignatureTx },
  });

  // 8. Assemble + broadcast
  onEvent({ kind: "step", name: "broadcastEth", status: "active" });
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
  const ethTxHash = await sepolia.sendRawTransaction(signedHex);
  onEvent({
    kind: "step",
    name: "broadcastEth",
    status: "done",
    data: { ethTxHash },
  });

  return {
    ethAddress,
    recipient: recipientHex,
    isSelfTransfer,
    signedHex,
    ethTxHash,
    signEthTransferTx,
    finalizeSignatureTx,
    payloadHex: bytesToHex(payload),
  };
}
