// POST /api/finalize
//
// Called by the frontend AFTER Phantom signed and confirmed the
// eth_demo::sign_eth_transfer instruction. The on-chain SigRequest PDA
// now exists with the right payload + foreign_pk_xy.
//
// This endpoint does the rest: MPC sign → soda::finalize_signature →
// broadcast the assembled signed RLP to Sepolia. The signing half is shared
// with /api/sui/finalize via lib/server-signing.ts; only the RLP envelope and
// the broadcast are EVM-specific.

import type { NextApiRequest, NextApiResponse } from "next";
import { PublicKey } from "@solana/web3.js";
import {
  bigintToBe,
  chainRpcUrl,
  eip155V,
  encodeSignedLegacy,
  encodeUnsignedLegacy,
  EthRpc,
} from "@soda-sdk/core";

import { chainMismatch, serverChain } from "@/lib/chain";
import {
  fetchSigRequest,
  openSoda,
  rememberLastTxHash,
  signRequestPayload,
  submitFinalizeSignature,
} from "@/lib/server-signing";

// Same chain the browser was built for (see lib/chain.ts). The chain id goes
// into the EIP-155 RLP that this route re-encodes, and the payload-recompute
// guard below fails loudly if it disagrees with what the browser committed
// on-chain.
const CHAIN = serverChain();
const SEPOLIA_CHAIN_ID = CHAIN.chainId;

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

    // Read the on-chain SigRequest to recover (payload, foreign_pk_xy,
    // derivation_seeds, chain_tag). We use these to compute the SODA tweak
    // and to know which payload the MPC committee should sign.
    const session = openSoda();
    const sigRequest = await fetchSigRequest(session, sigRequestPda);
    const payload: Uint8Array = Uint8Array.from(sigRequest.payload);

    const { sigBytes, recoveryId } = await signRequestPayload(
      session,
      sigRequestPda,
      sigRequest,
    );

    // Submit finalize_signature with server wallet as payer.
    const finalizeSignatureTx = await submitFinalizeSignature(
      session,
      sigRequestPda,
      sigBytes,
      recoveryId,
    );

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
    rememberLastTxHash(ethTxHash);

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
