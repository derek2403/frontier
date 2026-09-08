// Returns the committee's compressed secp256k1 group_pk so the page can
// derive the ETH address client-side.
//
// Reads from the on-chain Committee PDA rather than a local key file, so the
// page always reflects whatever key the deployed committee actually holds.
//
// The program id comes from the committed IDL, not a literal: this file used
// to hardcode the pre-`anchor keys sync` address, which silently pointed the
// whole UI at a different deployment than the rest of the app.

import type { NextApiRequest, NextApiResponse } from "next";
import { Connection, PublicKey } from "@solana/web3.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SODA_PROGRAM_ID as SODA_PROGRAM_ID_STR } from "@/lib/idls";
import { serverChain } from "@/lib/chain";

const SODA_PROGRAM_ID = new PublicKey(SODA_PROGRAM_ID_STR);
// Same path /api/finalize reads; reported here so a deployment with no key
// says so at page load rather than after Phantom has already signed.
const SIGNER_KEY_PATH = resolve(process.cwd(), "../..", "keyshare.dev.json");

// What this server will actually do when asked to sign. Reported here so the
// page describes the real backend instead of a NEXT_PUBLIC_* copy of it that
// can drift — the panel once advertised a coordinator that had been shut down
// for months because the display variable outlived the real one.
function signerInfo():
  | { mode: "mpc"; coordinator: string }
  | { mode: "dev-key"; source: "env" | "file" | "missing" } {
  const mpc = (process.env.MPC_COORDINATOR_URL ?? "").trim().replace(/\/+$/, "");
  if (mpc) return { mode: "mpc", coordinator: mpc };
  if ((process.env.SODA_SIGNER_KEY_HEX ?? "").trim()) {
    return { mode: "dev-key", source: "env" };
  }
  return {
    mode: "dev-key",
    source: existsSync(SIGNER_KEY_PATH) ? "file" : "missing",
  };
}

function solanaRpc(): string {
  return (
    process.env.SOLANA_RPC_URL ??
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
    "https://api.devnet.solana.com"
  );
}

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    const conn = new Connection(solanaRpc(), "confirmed");
    const [committeePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("committee")],
      SODA_PROGRAM_ID,
    );
    const acct = await conn.getAccountInfo(committeePda);
    if (!acct) {
      throw new Error(
        `Committee PDA ${committeePda.toBase58()} not initialised`,
      );
    }
    // Layout: 8-byte Anchor discriminator + u8 bump + 32-byte authority
    // + 33-byte group_pk + u8 signer_count.
    const groupPk = acct.data.subarray(8 + 1 + 32, 8 + 1 + 32 + 33);
    // Never cache. The committee key changes on update_committee, and a
    // browser serving a stale key derives the wrong ETH address, which then
    // fails finalize_signature with PubkeyMismatch and reads like a broken
    // committee rather than a stale tab.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({
      groupPkHex: "0x" + Buffer.from(groupPk).toString("hex"),
      committee: committeePda.toBase58(),
      // The chain the API routes are configured for. The page compares this
      // to the chain it was built for and refuses to proceed on a mismatch,
      // so a half-set deployment fails at load instead of at broadcast.
      chain: serverChain().key,
      signer: signerInfo(),
    });
  } catch (e) {
    return res.status(500).json({
      error: `Could not read on-chain Committee group_pk: ${(e as Error).message}`,
    });
  }
}
