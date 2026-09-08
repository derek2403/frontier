// POST /api/finalize
//
// Called by the frontend AFTER Phantom signed and confirmed the
// eth_demo::sign_eth_transfer instruction. The on-chain SigRequest PDA
// now exists with the right payload + foreign_pk_xy.
//
// This endpoint does the rest: MPC sign → soda::finalize_signature →
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
  bytesToBigInt,
  chainRpcUrl,
  computeTweak,
  eip155V,
  encodeSignedLegacy,
  encodeUnsignedLegacy,
  EthRpc,
} from "@soda-sdk/core";
import { secp256k1 } from "@noble/curves/secp256k1";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { sodaIdl } from "@/lib/idls";
import { chainMismatch, serverChain } from "@/lib/chain";

const REPO_ROOT = resolve(process.cwd(), "../..");
const LAST_TX_PATH = resolve(REPO_ROOT, ".last-tx-hash");
const SIGNER_KEY_PATH = resolve(REPO_ROOT, "keyshare.dev.json");

/**
 * The v0 single-key signer — the key whose pubkey is the on-chain
 * Committee.group_pk. Same key apps/demo uses, so both surfaces derive the
 * same addresses.
 *
 * Sources, in order:
 *   1. SODA_SIGNER_KEY_HEX — 32-byte hex. The only option on Vercel or any
 *      other serverless host, where ../../keyshare.dev.json does not exist.
 *   2. keyshare.dev.json at the repo root — local `pnpm dev`.
 *
 * This deliberately does NOT generate a key when neither is present, unlike
 * apps/demo (which may be initialising a fresh committee). By the time this
 * route runs, the committee already exists on-chain with a fixed group_pk;
 * a fresh random key can never match it, so generating one just moves the
 * failure to a PubkeyMismatch two steps later, with no hint of the cause.
 */
function loadSignerKey(): Uint8Array {
  const fromEnv = (process.env.SODA_SIGNER_KEY_HEX ?? "")
    .trim()
    .replace(/^0x/, "");
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error("SODA_SIGNER_KEY_HEX is set but is not 32 bytes of hex");
    }
    return Uint8Array.from(Buffer.from(fromEnv, "hex"));
  }
  if (existsSync(SIGNER_KEY_PATH)) {
    return Uint8Array.from(
      Buffer.from(readFileSync(SIGNER_KEY_PATH, "utf8").trim(), "hex"),
    );
  }
  throw new Error(
    `no signer key: set SODA_SIGNER_KEY_HEX (required on Vercel) or put the ` +
      `committee's key at ${SIGNER_KEY_PATH}. It must be the key whose pubkey ` +
      `is the on-chain Committee.group_pk.`,
  );
}

// Same chain the browser was built for (see lib/chain.ts). The chain id goes
// into the EIP-155 RLP that this route re-encodes, and the payload-recompute
// guard below fails loudly if it disagrees with what the browser committed
// on-chain.
const CHAIN = serverChain();
const SEPOLIA_CHAIN_ID = CHAIN.chainId;

// A dead coordinator host must surface as an error, not as a request that
// sits until the platform's function timeout kills it with no message.
const MPC_TIMEOUT_MS = 90_000;

type FinalizeReq = {
  /** Chain key the page was built for; refused if it is not the server's. */
  chain?: string;
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
  /** Hex calldata (with or without 0x). Empty/absent for a plain transfer. */
  dataHex?: string;
};

type FinalizeRes = {
  ethTxHash: string;
  signedHex: string;
  finalizeSignatureTx: string;
  recoveryId: number;
  ethAddress: string;
};

function sepoliaRpc(): string {
  return chainRpcUrl(CHAIN);
}

function solanaRpc(): string {
  return (
    process.env.SOLANA_RPC_URL ??
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
    "https://api.devnet.solana.com"
  );
}

function loadServerWallet(): Keypair {
  // 1. Vercel / production: keypair JSON inlined in env var.
  //    Set ANCHOR_WALLET_JSON to the contents of ~/.config/solana/id.json
  //    (a 64-element JSON array of bytes).
  const inline = process.env.ANCHOR_WALLET_JSON;
  if (inline) {
    try {
      const bytes = Uint8Array.from(JSON.parse(inline));
      return Keypair.fromSecretKey(bytes);
    } catch (e) {
      throw new Error(
        `ANCHOR_WALLET_JSON env var is set but not parseable as a 64-byte JSON array: ${(e as Error).message}`,
      );
    }
  }

  // 2. Local dev: read from disk.
  const path =
    process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`;
  if (!existsSync(path)) {
    throw new Error(
      `server wallet missing at ${path}. Either set ANCHOR_WALLET to a different path, or set ANCHOR_WALLET_JSON to the keypair's JSON array (required on Vercel / serverless).`,
    );
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
    const mismatch = chainMismatch(body.chain, CHAIN);
    if (mismatch) return res.status(400).json({ error: mismatch });
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
    const dataClean = (body.dataHex ?? "").replace(/^0x/, "");
    if (dataClean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(dataClean)) {
      return res.status(400).json({ error: "dataHex must be even-length hex" });
    }
    const data = Uint8Array.from(Buffer.from(dataClean, "hex"));

    // Explicit wsEndpoint: see the note in apps/demo/src/demo.ts — some
    // providers reject signatureSubscribe, stalling .rpc() confirmation.
    const connection = new Connection(solanaRpc(), {
      commitment: "confirmed",
      ...(process.env.SOLANA_WS_URL
        ? { wsEndpoint: process.env.SOLANA_WS_URL }
        : {}),
    });

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

    // Two signing paths, selected by whether MPC_COORDINATOR_URL is set —
    // the same switch apps/demo and lib/run-demo.ts use.
    //
    //   set   → MPC committee. Note the committee cannot currently apply the
    //           derivation tweak (Safeheron shares multiplicatively and P2
    //           holds a Paillier ciphertext of x1 fixed at DKG), so it signs
    //           for the untweaked group_pk and finalize_signature will reject
    //           it. Leave it unset until that is fixed.
    //   unset → v0 single-key signer. Applies the tweak correctly, so the
    //           signature recovers to the per-owner derived address. One key
    //           on disk, so this is not the "no private key anywhere" claim.
    //
    // Trailing slashes are stripped because Fastify treats `//sign` as a
    // different route and 404s, which looks silent.
    const MPC_URL = (process.env.MPC_COORDINATOR_URL ?? "").replace(/\/+$/, "");

    let sigBytes: Buffer;
    let recoveryId: number;

    if (MPC_URL) {
      const MPC_TOKEN = process.env.MPC_COORDINATOR_TOKEN;
      let mpcRes: Response;
      try {
        mpcRes = await fetch(`${MPC_URL}/sign`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(MPC_TOKEN ? { authorization: `Bearer ${MPC_TOKEN}` } : {}),
          },
          // Name the on-chain request; the nodes derive payload + tweak from it.
          body: JSON.stringify({ sigRequestPubkey: sigRequestPda.toBase58() }),
          signal: AbortSignal.timeout(MPC_TIMEOUT_MS),
        });
      } catch (e) {
        throw new Error(
          `mpc coordinator at ${MPC_URL} unreachable (${(e as Error).name}: ` +
            `${(e as Error).message}). If this host is decommissioned, unset ` +
            `MPC_COORDINATOR_URL to use the single-key signer.`,
        );
      }
      if (!mpcRes.ok) {
        throw new Error(`mpc coordinator ${mpcRes.status}: ${await mpcRes.text()}`);
      }
      const sig = (await mpcRes.json()) as { r: string; s: string; v: number };
      sigBytes = Buffer.concat([
        Buffer.from(sig.r, "hex"),
        Buffer.from(sig.s, "hex"),
      ]);
      recoveryId = sig.v;
    } else {
      // Re-derive the tweak from what the PROGRAM stored, not from anything
      // the client sent, so this signs for exactly the address on-chain.
      const tweak = computeTweak(
        new PublicKey(sigRequest.requester).toBytes(),
        Uint8Array.from(sigRequest.derivationSeeds),
        Uint8Array.from(sigRequest.chainTag),
      );
      const devSk = loadSignerKey();

      // Check the key against the on-chain committee BEFORE signing. A wrong
      // key otherwise fails inside finalize_signature as PubkeyMismatch,
      // which reads like a derivation bug rather than what it is: this
      // server holds a different key from the one init_committee registered.
      const [committeePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("committee")],
        sodaProgram.programId,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const committee = await (sodaProgram.account as any).committee.fetch(
        committeePda,
      );
      const onChainPk = Buffer.from(
        Uint8Array.from(committee.groupPk ?? committee.group_pk),
      ).toString("hex");
      const serverPk = Buffer.from(secp256k1.getPublicKey(devSk, true)).toString(
        "hex",
      );
      if (onChainPk !== serverPk) {
        throw new Error(
          `server signer key does not match the on-chain committee: ` +
            `Committee.group_pk is ${onChainPk.slice(0, 12)}… but this ` +
            `server's key gives ${serverPk.slice(0, 12)}…. Set ` +
            `SODA_SIGNER_KEY_HEX to the key that initialised the committee ` +
            `(the laptop's keyshare.dev.json), or run update_committee.`,
        );
      }

      const tweakedSkBig =
        (bytesToBigInt(devSk) + bytesToBigInt(tweak)) % secp256k1.CURVE.n;
      if (tweakedSkBig === 0n) throw new Error("tweaked sk is zero");
      const sig = secp256k1.sign(payload, bigintToBe(tweakedSkBig, 32), {
        lowS: true,
      });
      sigBytes = Buffer.from(sig.toCompactRawBytes());
      recoveryId = sig.recovery!;
    }

    // Submit finalize_signature with server wallet as payer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalizeSignatureTx = await (sodaProgram.methods as any)
      .finalizeSignature(Array.from(sigBytes), recoveryId)
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
      // Must match what the browser committed on-chain byte-for-byte; the
      // payload-recompute guard below is what catches a mismatch.
      data,
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

    const v = eip155V(recoveryId as 0 | 1, SEPOLIA_CHAIN_ID);
    const signedRlp = encodeSignedLegacy(
      baseTx,
      v,
      Uint8Array.from(sigBytes.subarray(0, 32)),
      Uint8Array.from(sigBytes.subarray(32, 64)),
    );
    const signedHex = "0x" + Buffer.from(signedRlp).toString("hex");

    // Broadcast.
    const sepolia = new EthRpc(sepoliaRpc());
    const ethTxHash = await sepolia.sendRawTransaction(signedHex);

    // Compute derived ETH address from the foreign_pk_xy that was stored.
    const fpkXy: Uint8Array = Uint8Array.from(sigRequest.foreignPkXy);
    const ethAddrBytes = keccak_256(fpkXy).subarray(12);
    const ethAddress = "0x" + Buffer.from(ethAddrBytes).toString("hex");

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
      recoveryId,
      ethAddress,
    };
    return res.status(200).json(result);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("/api/finalize failed:", e);
    return res.status(500).json({ error: msg });
  }
}
