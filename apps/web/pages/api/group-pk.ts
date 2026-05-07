// Returns the dev signer's compressed secp256k1 pubkey so the page can derive
// the ETH address client-side. The private key never leaves the server.

import type { NextApiRequest, NextApiResponse } from "next";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";

const KEYSHARE_PATH = resolve(process.cwd(), "../../keyshare.dev.json");

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const raw = readFileSync(KEYSHARE_PATH, "utf8").trim();
    const sk = Uint8Array.from(Buffer.from(raw, "hex"));
    const compressed = secp256k1.getPublicKey(sk, true);
    res.status(200).json({
      groupPkHex: "0x" + Buffer.from(compressed).toString("hex"),
    });
  } catch (e) {
    res.status(500).json({
      error: `Could not load dev signer key from ${KEYSHARE_PATH}: ${(e as Error).message}`,
    });
  }
}
