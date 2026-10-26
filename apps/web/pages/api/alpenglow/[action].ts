// API for the /alpenglow page. Testnet only (Solana devnet + Base Sepolia).
//
//   GET  state?owner=<base58>        the owner's SODA account on Base Sepolia
//   GET  demo-owner                  the server's devnet demo key, if any
//   POST prepare     { owner }       fund the account, return the memo to sign
//   POST demo-sign   { memo }        sign the memo with the demo key
//   POST certify     { signature, nonSigners }   certificate -> light client
//   POST execute     { signature }   the account runs the approved deposit
//   GET  local-status                our local Alpenglow node and its footer stream
//
// Every route takes net=devnet (simulated certificate) or net=local (our own
// Alpenglow node; real certificate from its block footer).

import type { NextApiRequest, NextApiResponse } from "next";
import { keccak256 } from "viem";
import { AAVE_V3_BASE_SEPOLIA } from "@soda-sdk/core";

import { ALPENGLOW, approvalMemo, DEPOSIT_WEI, NON_SIGNER_CHOICES, type PrepareResponse } from "@/lib/alpenglow/shared";
import {
  accountState,
  certify,
  demoOwner,
  demoSign,
  depositCalldata,
  execute,
  fundIfNeeded,
  type Net,
} from "@/lib/alpenglow/server";
import { certifyLocal, localStatus } from "@/lib/alpenglow/local";

export const config = { maxDuration: 120 };

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const action = String(req.query.action);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const net: Net = (req.query.net ?? body.net) === "local" ? "local" : "devnet";
  try {
    if (req.method === "GET" && action === "state") {
      return res.status(200).json(await accountState(String(req.query.owner), net));
    }
    if (req.method === "GET" && action === "local-status") {
      return res.status(200).json(await localStatus());
    }
    if (req.method === "GET" && action === "demo-owner") {
      return res.status(200).json({ owner: demoOwner()?.publicKey.toBase58() ?? null });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

    if (action === "prepare") {
      const state = await accountState(String(body.owner), net);
      const funding = await fundIfNeeded(state.account, BigInt(state.balanceWei));
      const fresh = funding ? await accountState(String(body.owner), net) : state;
      const memo = approvalMemo({
        chainId: ALPENGLOW.chainId,
        account: fresh.account,
        target: AAVE_V3_BASE_SEPOLIA.WETH_GATEWAY as `0x${string}`,
        value: DEPOSIT_WEI,
        dataHash: keccak256(depositCalldata(fresh.account)),
        nonce: BigInt(fresh.nonce),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      });
      const out: PrepareResponse = { ...fresh, memo, funding };
      return res.status(200).json(out);
    }
    if (action === "demo-sign") {
      return res.status(200).json(await demoSign(String(body.memo), net));
    }
    if (action === "certify" && net === "local") {
      return res.status(200).json(json(await certifyLocal(String(body.signature))));
    }
    if (action === "certify") {
      const n = Number(body.nonSigners ?? 0);
      if (!(NON_SIGNER_CHOICES as readonly number[]).includes(n)) {
        return res.status(400).json({ error: `nonSigners must be one of ${NON_SIGNER_CHOICES.join(", ")}` });
      }
      return res.status(200).json(json(await certify(String(body.signature), n)));
    }
    if (action === "execute") {
      return res.status(200).json(json(await execute(String(body.signature), net)));
    }
    return res.status(404).json({ error: `unknown action ${action}` });
  } catch (e) {
    const err = e as Error & { shortMessage?: string };
    return res.status(500).json({ error: err.shortMessage ?? err.message });
  }
}
