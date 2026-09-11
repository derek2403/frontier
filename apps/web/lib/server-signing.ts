// What every finalize route shares: the Solana payer, the committee's signer
// key, the soda program handle, and the two signing paths (MPC committee or
// the v0 single key). /api/finalize (EVM) and /api/sui/finalize differ only in
// the envelope around the 32-byte payload — RLP + eth_sendRawTransaction
// versus BCS + executeTransaction — so everything below the envelope lives
// here once. Server-only: reads files and env, never imported by a page.

import { AnchorProvider, Program, type Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { bigintToBe, bytesToBigInt, computeTweak } from "@soda-sdk/core";
import { secp256k1 } from "@noble/curves/secp256k1";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { sodaIdl } from "@/lib/idls";

export const REPO_ROOT = resolve(process.cwd(), "../..");
// Read by demo.sh so `pnpm verify` / `pnpm verify:sui` can chain off the last
// broadcast without a copy-paste of the hash.
export const LAST_TX_PATH = resolve(REPO_ROOT, ".last-tx-hash");
export const SIGNER_KEY_PATH = resolve(REPO_ROOT, "keyshare.dev.json");

// A dead coordinator host must surface as an error, not as a request that
// sits until the platform's function timeout kills it with no message.
export const MPC_TIMEOUT_MS = 90_000;

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
 * apps/demo (which may be initialising a fresh committee). By the time a
 * finalize route runs, the committee already exists on-chain with a fixed
 * group_pk; a fresh random key can never match it, so generating one just
 * moves the failure to a PubkeyMismatch two steps later, with no hint of the
 * cause.
 */
export function loadSignerKey(): Uint8Array {
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

export function solanaRpc(): string {
  return (
    process.env.SOLANA_RPC_URL ??
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
    "https://api.devnet.solana.com"
  );
}

export function loadServerWallet(): Keypair {
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

/**
 * Anchor-compatible Wallet around a Keypair. AnchorProvider calls
 * wallet.signTransaction(tx) when .rpc() runs, so it needs more than just
 * { publicKey } — it needs an actual signer.
 */
export function anchorWalletFor(serverWallet: Keypair): Wallet {
  return {
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
}

export type SodaSession = {
  connection: Connection;
  serverWallet: Keypair;
  // The IDL is a plain JSON import, so the generated types are not available;
  // callers cast `.account` / `.methods` the way the routes always have.
  sodaProgram: Program;
  committeePda: PublicKey;
};

/** Connection + payer + soda program handle, the way every route builds them. */
export function openSoda(): SodaSession {
  // Explicit wsEndpoint: see the note in apps/demo/src/demo.ts — some
  // providers reject signatureSubscribe, stalling .rpc() confirmation.
  const connection = new Connection(solanaRpc(), {
    commitment: "confirmed",
    ...(process.env.SOLANA_WS_URL
      ? { wsEndpoint: process.env.SOLANA_WS_URL }
      : {}),
  });
  const serverWallet = loadServerWallet();
  const provider = new AnchorProvider(connection, anchorWalletFor(serverWallet), {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sodaProgram = new Program(sodaIdl as any, provider);
  const [committeePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("committee")],
    sodaProgram.programId,
  );
  return { connection, serverWallet, sodaProgram, committeePda };
}

/** The on-chain SigRequest as Anchor decodes it — only the fields routes read. */
export type SigRequestAccount = {
  requester: PublicKey;
  foreignPkXy: ArrayLike<number>;
  derivationSeeds: ArrayLike<number>;
  payload: ArrayLike<number>;
  chainTag: ArrayLike<number>;
  completed: boolean;
};

export async function fetchSigRequest(
  session: SodaSession,
  sigRequestPda: PublicKey,
): Promise<SigRequestAccount> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (session.sodaProgram.account as any).sigRequest.fetch(sigRequestPda);
}

/**
 * Produce the committee's signature over the request's payload.
 *
 * Two signing paths, selected by whether MPC_COORDINATOR_URL is set —
 * the same switch apps/demo and lib/run-demo.ts use.
 *
 *   set   → MPC committee. Note the committee cannot currently apply the
 *           derivation tweak (Safeheron shares multiplicatively and P2
 *           holds a Paillier ciphertext of x1 fixed at DKG), so it signs
 *           for the untweaked group_pk and finalize_signature will reject
 *           it. Leave it unset until that is fixed.
 *   unset → v0 single-key signer. Applies the tweak correctly, so the
 *           signature recovers to the per-owner derived address. One key
 *           on disk, so this is not the "no private key anywhere" claim.
 */
export async function signRequestPayload(
  session: SodaSession,
  sigRequestPda: PublicKey,
  sigRequest: SigRequestAccount,
): Promise<{ sigBytes: Buffer; recoveryId: number }> {
  const payload: Uint8Array = Uint8Array.from(sigRequest.payload);

  // Trailing slashes are stripped because Fastify treats `//sign` as a
  // different route and 404s, which looks silent.
  const MPC_URL = (process.env.MPC_COORDINATOR_URL ?? "").replace(/\/+$/, "");

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
    return {
      sigBytes: Buffer.concat([
        Buffer.from(sig.r, "hex"),
        Buffer.from(sig.s, "hex"),
      ]),
      recoveryId: sig.v,
    };
  }

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const committee = await (session.sodaProgram.account as any).committee.fetch(
    session.committeePda,
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
  return {
    sigBytes: Buffer.from(sig.toCompactRawBytes()),
    recoveryId: sig.recovery!,
  };
}

/** soda::finalize_signature with the server wallet as payer; returns the tx sig. */
export async function submitFinalizeSignature(
  session: SodaSession,
  sigRequestPda: PublicKey,
  sigBytes: Uint8Array,
  recoveryId: number,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (session.sodaProgram.methods as any)
    .finalizeSignature(Array.from(sigBytes), recoveryId)
    .accounts({
      committee: session.committeePda,
      sigRequest: sigRequestPda,
      submitter: session.serverWallet.publicKey,
    })
    .rpc();
}

/** Stash the foreign tx id for `pnpm verify`. Best effort: read-only hosts skip it. */
export function rememberLastTxHash(hash: string): void {
  try {
    writeFileSync(LAST_TX_PATH, hash);
  } catch {
    /* swallow */
  }
}
