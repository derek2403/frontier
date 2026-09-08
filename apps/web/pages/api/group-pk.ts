// Returns the committee's compressed secp256k1 group_pk so the page can
// derive the ETH address client-side.
//
// Reads from the on-chain Committee PDA, NOT from a local key file —
// after the MPC migration (update_committee), the joint key is whatever
// the MPC committee produced via DKG. The private material never
// exists in one place.

import type { NextApiRequest, NextApiResponse } from "next";
import { Connection, PublicKey } from "@solana/web3.js";

const SODA_PROGRAM_ID = new PublicKey(
  "2YDHaX2fPXdmH14hgSJQHMJQpEHrXofzhu5hDVFgFiVd",
);

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
    // browser serving a stale key derives the wrong ETH address. The page
    // then builds a SigRequest against that address and finalize_signature
    // fails with PubkeyMismatch, which reads like a broken committee rather
    // than a stale tab.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({
      groupPkHex: "0x" + Buffer.from(groupPk).toString("hex"),
      committee: committeePda.toBase58(),
    });
  } catch (e) {
    return res.status(500).json({
      error: `Could not read on-chain Committee group_pk: ${(e as Error).message}`,
    });
  }
}
