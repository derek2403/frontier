// POST /api/finalize
//
// Called by the frontend AFTER Phantom signed and confirmed the
// eth_demo::sign_eth_transfer instruction. The on-chain SigRequest PDA
// now exists with the right payload + foreign_pk_xy.
//
// This endpoint does the rest: AWS MPC sign → soda::finalize_signature →
// broadcast the assembled signed RLP to Sepolia.

import type { NextApiRequest, NextApiResponse } from "next";
import { AnchorProvider, Program, type Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  bigintToBe,
  eip155V,
  encodeSignedLegacy,
  encodeUnsignedLegacy,
  EthRpc,
} from "@soda-sdk/core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { sodaIdl } from "@/lib/idls";

const REPO_ROOT = resolve(process.cwd(), "../..");
const LAST_TX_PATH = resolve(REPO_ROOT, ".last-tx-hash");

const SEPOLIA_CHAIN_ID = 11_155_111n;

type FinalizeReq = {
  /** Base58 PublicKey of the SigRequest PDA created by sign_eth_transfer */
  sigRequestPda: string;
  /** Hex (no 0x prefix), 20 bytes */
  recipientHex: string;
  /** Decimal string of the bigint */
  nonce: string;
  /** Decimal string */
  gasPriceWei: string;
  /** Decimal string */
  gasLimit: string;
  /** Decimal string */
  valueWei: string;
};

type FinalizeRes = {
  ethTxHash: string;
  signedHex: string;
  finalizeSignatureTx: string;
  recoveryId: number;
  ethAddress: string;
  isSelfTransfer: boolean;
};

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
    "https://api.devnet.solana.com"
  );
}

function loadServerWallet(): Keypair {
  const path =
    process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`;
  if (!existsSync(path)) {
    throw new Error(`server wallet missing at ${path}`);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf-8"))),
  );
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const body = req.body as FinalizeReq;
    if (
      !body.sigRequestPda ||
      !body.recipientHex ||
      body.nonce == null ||
      body.gasPriceWei == null ||
      body.gasLimit == null ||
      body.valueWei == null
    ) {
      return res.status(400).json({ error: "missing fields" });
    }

    const sigRequestPda = new PublicKey(body.sigRequestPda);
    const recipient = Buffer.from(body.recipientHex.replace(/^0x/, ""), "hex");
    if (recipient.length !== 20) {
      return res.status(400).json({ error: "recipientHex must be 20 bytes" });
    }
    const nonce = BigInt(body.nonce);
    const gasPriceWei = BigInt(body.gasPriceWei);
    const gasLimit = BigInt(body.gasLimit);
    const valueWei = BigInt(body.valueWei);

    const connection = new Connection(solanaRpc(), "confirmed");

    // Read the on-chain SigRequest to recover (payload, foreign_pk_xy,
    // derivation_seeds, chain_tag). We use these to compute the SODA tweak
    // and to know which payload the MPC committee should sign.
    const serverWallet = loadServerWallet();
    // Build an Anchor-compatible Wallet wrapper around our Keypair.
    // Anchor's AnchorProvider calls wallet.signTransaction(tx) when .rpc()
    // runs, so it needs more than just { publicKey } — it needs an actual
    // signer.
    const anchorWallet: Wallet = {
      publicKey: serverWallet.publicKey,
      payer: serverWallet,
      signTransaction: async <T extends Transaction | VersionedTransaction>(
        tx: T,
      ): Promise<T> => {
        if (tx instanceof VersionedTransaction) {
          tx.sign([serverWallet]);
        } else {
          tx.partialSign(serverWallet);
        }
        return tx;
      },
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(
        txs: T[],
      ): Promise<T[]> => {
        for (const tx of txs) {
          if (tx instanceof VersionedTransaction) {
            tx.sign([serverWallet]);
          } else {
            tx.partialSign(serverWallet);
          }
        }
        return txs;
      },
    };
    const provider = new AnchorProvider(connection, anchorWallet, {
      commitment: "confirmed",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sodaProgram = new Program(sodaIdl as any, provider);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sigRequest = await (sodaProgram.account as any).sigRequest.fetch(
      sigRequestPda,
    );
    const payload: Uint8Array = Uint8Array.from(sigRequest.payload);
    const seeds: Uint8Array = Uint8Array.from(sigRequest.derivationSeeds);
    const chainTag: Uint8Array = Uint8Array.from(sigRequest.chainTag);
    const requester: PublicKey = sigRequest.requester;

    // Compute tweak from (requester, seeds, chainTag) — same algorithm as
    // soda-sdk's computeTweak.
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const tweakInput = new Uint8Array(
      7 + 32 + seeds.length + 32, // "SODA-v1" + pubkey + seeds + chain_tag
    );
    let o = 0;
    tweakInput.set(new TextEncoder().encode("SODA-v1"), o); o += 7;
    tweakInput.set(requester.toBytes(), o); o += 32;
    tweakInput.set(seeds, o); o += seeds.length;
    tweakInput.set(chainTag, o);
    const tweak = sha256(tweakInput);

    // Call AWS MPC coordinator.
    const MPC_URL = process.env.MPC_COORDINATOR_URL;
    if (!MPC_URL) {
      return res.status(500).json({ error: "MPC_COORDINATOR_URL not set" });
    }
    const mpcRes = await fetch(`${MPC_URL}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payloadHex: Buffer.from(payload).toString("hex"),
        tweakHex: Buffer.from(tweak).toString("hex"),
      }),
    });
    if (!mpcRes.ok) {
      throw new Error(`mpc coordinator ${mpcRes.status}: ${await mpcRes.text()}`);
    }
    const sig = (await mpcRes.json()) as { r: string; s: string; v: number };
    const sigBytes = Buffer.concat([
      Buffer.from(sig.r, "hex"),
      Buffer.from(sig.s, "hex"),
    ]);

    // Submit finalize_signature with server wallet as payer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalizeSignatureTx = await (sodaProgram.methods as any)
      .finalizeSignature(Array.from(sigBytes), sig.v)
      .accounts({
        committee: PublicKey.findProgramAddressSync(
          [Buffer.from("committee")],
          sodaProgram.programId,
        )[0],
        sigRequest: sigRequestPda,
        submitter: serverWallet.publicKey,
      })
      .rpc();

    // Reconstruct unsigned RLP (we have all the params), then sign it
    // with the MPC-produced (r, s, v) → EIP-155 v.
    const valueWeiBe = bigintToBe(valueWei, 16);
    const baseTx = {
      nonce,
      gasPriceWei,
      gasLimit,
      to: new Uint8Array(recipient),
      valueWeiBe,
      data: new Uint8Array(0),
      chainId: SEPOLIA_CHAIN_ID,
    };
    // Sanity: the keccak of unsignedRlp must match the on-chain payload
    const { keccak_256 } = await import("@noble/hashes/sha3.js");
    const recomputedPayload = keccak_256(encodeUnsignedLegacy(baseTx));
    const payloadHex = Buffer.from(payload).toString("hex");
    const recomputedHex = Buffer.from(recomputedPayload).toString("hex");
    if (payloadHex !== recomputedHex) {
      throw new Error(
        `payload mismatch — on-chain ${payloadHex} vs recomputed ${recomputedHex}. tx params don't match what was on-chain.`,
      );
    }

    const v = eip155V(sig.v as 0 | 1, SEPOLIA_CHAIN_ID);
    const signedRlp = encodeSignedLegacy(
      baseTx,
      v,
      Buffer.from(sig.r, "hex"),
      Buffer.from(sig.s, "hex"),
    );
    const signedHex = "0x" + Buffer.from(signedRlp).toString("hex");

    // Broadcast.
    const sepolia = new EthRpc(sepoliaRpc());
    const ethTxHash = await sepolia.sendRawTransaction(signedHex);

    // Compute derived ETH address from the foreign_pk_xy that was stored.
    const fpkXy: Uint8Array = Uint8Array.from(sigRequest.foreignPkXy);
    const ethAddrBytes = keccak_256(fpkXy).subarray(12);
    const ethAddress = "0x" + Buffer.from(ethAddrBytes).toString("hex");
    const recipientHexNormalized = "0x" + Buffer.from(recipient).toString("hex");
    const isSelfTransfer =
      recipientHexNormalized.toLowerCase() === ethAddress.toLowerCase();

    // Stash the ETH tx hash for `pnpm verify`.
    try {
      writeFileSync(LAST_TX_PATH, ethTxHash);
    } catch {
      /* swallow */
    }

    const result: FinalizeRes = {
      ethTxHash,
      signedHex,
      finalizeSignatureTx,
      recoveryId: sig.v,
      ethAddress,
      isSelfTransfer,
    };
    return res.status(200).json(result);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("/api/finalize failed:", e);
    return res.status(500).json({ error: msg });
  }
}
