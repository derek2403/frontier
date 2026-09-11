// POST /api/fund  { address }
//
// Tops up a SODA-derived address from the sponsor key so the UI never dead-ends
// on an unfunded address. Mirrors fundFromSponsor() in apps/demo/src/demo.ts.
//
// Gas on Ethereum is paid by the transaction's `from` account, and no third
// party can pay on behalf of a plain EOA — so something has to put ETH at the
// derived address before it can transact. Here that is a key in .env; in
// production it is a relayer that fronts the gas and bills the user in SOL.
//
// Deliberately capped: the sponsor is a hot key in a dotfile, so a bug here
// should cost cents.

import type { NextApiRequest, NextApiResponse } from "next";
import {
  bigintToBe,
  eip155V,
  encodeSignedLegacy,
  encodeUnsignedLegacy,
  ethAddressFromPk,
  EthRpc,
} from "@soda-sdk/core";
import { chainRpcUrl, getChain } from "@soda-sdk/core";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

// Same DEMO_CHAIN the CLI uses, so the sponsor funds on the chain the demo
// will actually broadcast to. Each chain has its own sponsor balance.
const CHAIN = getChain(process.env.DEMO_CHAIN);
const SEPOLIA_CHAIN_ID = CHAIN.chainId;
const FUNDING_THRESHOLD_WEI = 200_000_000_000_000n; // 0.0002 ETH
const MAX_TOPUP_WEI = 2_000_000_000_000_000n; // 0.002 ETH

function sepoliaRpc(): string {
  return chainRpcUrl(CHAIN);
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const body = req.body as { address?: string; minWei?: string };
    const target = String(body?.address ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
      return res.status(400).json({ error: "address must be 20 bytes hex" });
    }
    // Callers that are about to make a contract call need more than a plain
    // transfer does (an Aave deposit burns ~230k gas). Let them raise the
    // target, but never above the per-run cap — that cap is the safety net.
    let threshold = FUNDING_THRESHOLD_WEI;
    if (body?.minWei != null) {
      const requested = BigInt(String(body.minWei));
      threshold = requested > MAX_TOPUP_WEI ? MAX_TOPUP_WEI : requested;
    }

    const raw = (process.env.SEPOLIA_FUNDER_KEY ?? "").trim().replace(/^0x/, "");
    if (!raw) {
      return res.status(503).json({
        error:
          "SEPOLIA_FUNDER_KEY is not set — fund the address from a faucet, or set the key in .env to auto-fund.",
      });
    }
    if (raw.length !== 64) {
      return res
        .status(500)
        .json({ error: "SEPOLIA_FUNDER_KEY is not a 32-byte hex key" });
    }

    const rpc = new EthRpc(sepoliaRpc());

    // Already funded? Nothing to do — makes the endpoint idempotent, so a
    // double-click or a retry cannot drain the sponsor.
    const current = await rpc.getBalance(target);
    if (current >= threshold) {
      return res.status(200).json({ funded: true, balanceWei: current.toString() });
    }

    const sk = Uint8Array.from(Buffer.from(raw, "hex"));
    const funder = bytesToHex(
      ethAddressFromPk(secp256k1.getPublicKey(sk, false)),
    );

    const need = threshold - current;
    const topUp = need > MAX_TOPUP_WEI ? MAX_TOPUP_WEI : need;
    const gasPriceWei = (await rpc.getGasPrice()) * 2n;
    const gasLimit = 21_000n;

    const funderBal = await rpc.getBalance(funder);
    if (funderBal < topUp + gasPriceWei * gasLimit) {
      return res.status(503).json({
        error: `sponsor ${funder} has ${funderBal} wei, needs ${topUp + gasPriceWei * gasLimit}`,
      });
    }

    const to = Uint8Array.from(Buffer.from(target.replace(/^0x/, ""), "hex"));
    const valueWeiBe = bigintToBe(topUp, 16);
    const nonce = await rpc.getNonce(funder);

    const unsigned = encodeUnsignedLegacy({
      nonce,
      gasPriceWei,
      gasLimit,
      to,
      valueWeiBe,
      data: new Uint8Array(0),
      chainId: SEPOLIA_CHAIN_ID,
    });
    const sig = secp256k1.sign(keccak_256(unsigned), sk, { lowS: true });
    const signed = encodeSignedLegacy(
      { nonce, gasPriceWei, gasLimit, to, valueWeiBe, data: new Uint8Array(0) },
      eip155V(sig.recovery as 0 | 1, SEPOLIA_CHAIN_ID),
      bigintToBe(sig.r, 32),
      bigintToBe(sig.s, 32),
    );

    const txHash = await rpc.sendRawTransaction(bytesToHex(signed));

    // Wait for the balance to actually move rather than for a receipt — the
    // balance is what the next step depends on.
    let balance = current;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      balance = await rpc.getBalance(target).catch(() => balance);
      if (balance >= threshold) {
        return res
          .status(200)
          .json({ funded: true, txHash, balanceWei: balance.toString() });
      }
    }
    return res.status(504).json({
      error: "sponsor tx did not confirm in time",
      txHash,
      balanceWei: balance.toString(),
    });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
