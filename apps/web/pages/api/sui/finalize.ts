// POST /api/sui/finalize  { chain, sigRequestPda, txBytesB64 }
//
// Called by the frontend AFTER Phantom signed and confirmed the
// sui_demo::sign_sui_transfer instruction. The on-chain SigRequest PDA now
// exists with payload = sha256(blake2b(intent || tx_bytes)) and the
// program-derived foreign_pk_xy.
//
// This endpoint does the rest: sign → soda::finalize_signature → attach
// `0x01 || r || s || pk` to the tx bytes and submit them to Sui. The signing
// half is /api/finalize's, shared via lib/server-signing.ts; what is Sui
// here is the guard on the bytes and the envelope.
//
// The browser sends the BCS bytes because the program does not store them —
// only their hash. So before anything is signed, the bytes are hashed the way
// the program hashed its own and compared to what soda stored. If they differ
// the client built a different transaction from the one Phantom approved,
// and this route refuses rather than sign it.

import type { NextApiRequest, NextApiResponse } from "next";
import { PublicKey } from "@solana/web3.js";
import {
  bytesToHex0x,
  compressPk,
  encodeSuiSignature,
  suiAddressFromPk,
  SuiGraphQl,
  suiGraphqlUrl,
  suiSigningPayload,
} from "@soda-sdk/core";

import { serverSuiChain, suiChainMismatch } from "@/lib/chain";
import {
  fetchSigRequest,
  openSoda,
  rememberLastTxHash,
  signRequestPayload,
  submitFinalizeSignature,
} from "@/lib/server-signing";

// Same network the browser was built for (see lib/chain.ts).
const CHAIN = serverSuiChain();

type FinalizeReq = {
  /** Chain key the page was built for; refused if it is not the server's. */
  chain?: string;
  /** Base58 PublicKey of the SigRequest PDA created by sign_sui_transfer */
  sigRequestPda: string;
  /** BCS TransactionData, base64 — the bytes the program hashed on-chain. */
  txBytesB64: string;
};

type FinalizeRes = {
  digest: string;
  status: "SUCCESS";
  finalizeSignatureTx: string;
  recoveryId: number;
  suiAddress: string;
  explorerTx: string;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Is `expected` the sender of this BCS `TransactionData::V1`?
 *
 * The kind at the front is variable-length and the SDK has no BCS decoder,
 * but the tail has a fixed shape once the program's choices are known — it
 * sets gas_owner = sender, bounds gas_payment at MAX_GAS_COINS and never sets
 * an expiration:
 *
 *   … sender(32) | uleb(n) | n × { id(32) version(8) 0x20 digest(32) }
 *     | gas_owner(32) | gas_price(8) | gas_budget(8) | expiration = 0x00
 *
 * So the gas owner sits at a fixed offset from the end, and the sender is
 * the 32 bytes before the coin count for whichever n fits. Both must be the
 * derived address; a 32-byte hash matching by coincidence inside the kind is
 * not a realistic event.
 */
function suiSenderIs(txBytes: Uint8Array, expected: Uint8Array): boolean {
  const REF = 32 + 8 + 1 + 32;
  const TAIL = 32 + 8 + 8 + 1;
  const len = txBytes.length;
  if (len < 1 + 1 + 32 + 1 + REF + TAIL) return false;
  if (txBytes[len - 1] !== 0) return false; // expiration: None
  if (!bytesEqual(txBytes.subarray(len - TAIL, len - TAIL + 32), expected)) return false;
  for (let n = 1; n < 128; n++) {
    const countAt = len - TAIL - n * REF - 1;
    if (countAt < 1 + 32) break;
    if (txBytes[countAt] !== n) continue;
    if (bytesEqual(txBytes.subarray(countAt - 32, countAt), expected)) return true;
  }
  return false;
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
    const mismatch = suiChainMismatch(body.chain, CHAIN);
    if (mismatch) return res.status(400).json({ error: mismatch });
    if (!body.sigRequestPda || !body.txBytesB64) {
      return res.status(400).json({ error: "missing fields" });
    }

    const sigRequestPda = new PublicKey(body.sigRequestPda);
    let txBytes: Uint8Array;
    try {
      txBytes = Uint8Array.from(Buffer.from(String(body.txBytesB64), "base64"));
    } catch {
      txBytes = new Uint8Array(0);
    }
    if (txBytes.length === 0) {
      return res.status(400).json({ error: "txBytesB64 must be base64 BCS TransactionData" });
    }

    // Read the on-chain SigRequest: the payload the program committed, the
    // foreign_pk_xy it derived, and the inputs to the signing tweak.
    const session = openSoda();
    const sigRequest = await fetchSigRequest(session, sigRequestPda);
    const payload = Uint8Array.from(sigRequest.payload);
    const foreignPkXy = Uint8Array.from(sigRequest.foreignPkXy);
    const foreignPk = new Uint8Array(65);
    foreignPk[0] = 0x04;
    foreignPk.set(foreignPkXy, 1);
    const senderBytes = suiAddressFromPk(foreignPk);
    const suiAddress = bytesToHex0x(senderBytes);

    // ---- The guard. Refuse unless the bytes are exactly what the program
    // hashed and the sender inside them is the program-derived address. ----
    const recomputed = suiSigningPayload(txBytes);
    if (!bytesEqual(recomputed, payload)) {
      return res.status(400).json({
        error:
          `payload mismatch — on-chain ${bytesToHex0x(payload)} vs ` +
          `sha256(blake2b(intent || txBytes)) = ${bytesToHex0x(recomputed)}. ` +
          `The bytes sent are not the transaction the program committed; refusing to sign.`,
      });
    }
    if (!suiSenderIs(txBytes, senderBytes)) {
      return res.status(400).json({
        error:
          `sender mismatch — the transaction's sender is not ${suiAddress}, the ` +
          `address the program derived for this request; refusing to sign.`,
      });
    }
    const onChainTag = Uint8Array.from(sigRequest.chainTag);
    if (!bytesEqual(onChainTag, CHAIN.chainTag)) {
      return res.status(400).json({
        error:
          `this SigRequest was committed for another chain tag, not ${CHAIN.key}; ` +
          `the derived address only exists on the network in the tag.`,
      });
    }

    const { sigBytes, recoveryId } = await signRequestPayload(
      session,
      sigRequestPda,
      sigRequest,
    );

    // Submit finalize_signature with server wallet as payer. This is where
    // secp256k1_recover checks the signature against foreign_pk_xy on-chain.
    const finalizeSignatureTx = await submitFinalizeSignature(
      session,
      sigRequestPda,
      sigBytes,
      recoveryId,
    );

    // Sui wants `flag || r || s || pubkey`; the pubkey is the derived key, and
    // Sui checks blake2b(flag || pubkey) == sender before it checks the ECDSA.
    const serializedSig = encodeSuiSignature(
      Uint8Array.from(sigBytes),
      compressPk(foreignPk),
    );
    const sui = new SuiGraphQl(suiGraphqlUrl(CHAIN));
    const exec = await sui.executeTransaction(txBytes, [serializedSig]);
    const explorerTx = CHAIN.explorerTx(exec.digest);

    if (exec.status !== "SUCCESS") {
      // Sui ran it and it failed (gas, a spent coin, a Move abort). The
      // signature itself was accepted — the digest is real and on the
      // explorer — so return it along with the reason.
      return res.status(500).json({
        error: `Sui executed the transaction but it failed: ${exec.error ?? "unknown"}`,
        digest: exec.digest,
        status: exec.status,
        finalizeSignatureTx,
        explorerTx,
      });
    }

    // Stash the digest for `pnpm verify:sui`.
    rememberLastTxHash(exec.digest);

    const result: FinalizeRes = {
      digest: exec.digest,
      status: "SUCCESS",
      finalizeSignatureTx,
      recoveryId,
      suiAddress,
      explorerTx,
    };
    return res.status(200).json(result);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("/api/sui/finalize failed:", e);
    return res.status(500).json({ error: msg });
  }
}
