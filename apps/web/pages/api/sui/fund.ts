// POST /api/sui/fund  { chain, address, minMist? }
//
// Tops up a SODA-derived Sui address so the UI never dead-ends on an unfunded
// address. Mirrors fundFromSponsor() + fundFromFaucet() in
// apps/demo/src/demo-sui.ts, and /api/fund for the EVM page.
//
// Gas on Sui is paid from the sender's own coins, exactly like ETH: something
// has to put SUI at the derived address before it can transact. Two sources,
// tried in order:
//   1. SUI_FUNDER_KEY — a sponsor key in .env, so a run does not stall on a
//      human visiting a faucet. Its transfer is built with the SDK's encoder
//      and signed locally: the same code path the committee's signature will
//      take, minus the committee.
//   2. The public faucet, which rate-limits per IP. A refusal is reported
//      with the address so the user can fund it by hand and click again.
//
// Deliberately capped: the sponsor is a hot key in a dotfile, so a bug here
// should cost cents.

import type { NextApiRequest, NextApiResponse } from "next";
import {
  bytesToHex0x,
  fetchSpendableCoins,
  encodeSuiTransactionData,
  encodeSuiTransferKind,
  MIST_PER_SUI,
  parseSuiAddress,
  parseSuiAddressStrict,
  parseSuiPrivateKey,
  requestSuiFromFaucet,
  signSuiTransactionWithKey,
  SUI_MAX_GAS_COINS,
  SUI_MIN_BALANCE_MIST,
  SUI_SPONSOR_MAX_TOPUP_MIST,
  SUI_TRANSFER_GAS_BUDGET_MIST,
  suiAddressFromKey,
  SuiGraphQl,
  suiGraphqlUrl,
  SuiJsonRpc,
  suiRpcUrl,
} from "@soda-sdk/core";

import { serverSuiChain, suiChainMismatch } from "@/lib/chain";

// Same network the browser was built for (see lib/chain.ts), so the sponsor
// funds where the demo will actually submit. Each network has its own
// sponsor balance.
const CHAIN = serverSuiChain();
const GAS_BUDGET_MIST = SUI_TRANSFER_GAS_BUDGET_MIST;
// The balance is what the next step depends on, so that is what we wait for:
// 40 × 3s, the same window /api/fund gives an EVM top-up.
const POLL_TRIES = 40;
const POLL_INTERVAL_MS = 3_000;

function graphql(): string {
  return suiGraphqlUrl(CHAIN);
}

/** Optional JSON-RPC source; see SuiJsonRpc for why the sponsor needs it. */
function rpcClient(): SuiJsonRpc | null {
  const url = suiRpcUrl(CHAIN);
  return url ? new SuiJsonRpc(url) : null;
}

function fmtSui(mist: bigint): string {
  return `${(Number(mist) / Number(MIST_PER_SUI)).toFixed(4)} SUI`;
}

/** Where a human can get test SUI when neither automatic source could. */
function manualHint(target: string): string {
  const net = CHAIN.key.replace("sui-", "");
  return (
    `Fund ${target} with ~${fmtSui(SUI_MIN_BALANCE_MIST)} on ${CHAIN.name} at ` +
    `https://faucet.sui.io (pick ${net}), or set SUI_FUNDER_KEY in .env to ` +
    `auto-fund, then click again.`
  );
}

type FundedFrom = { source: "sponsor" | "faucet"; digest?: string };

/**
 * Poll until the balance clears the threshold. Ends the request either way:
 * 200 with the balance, or 504 naming what was sent so the user can look it
 * up rather than assume nothing happened.
 */
async function waitForBalance(
  res: NextApiResponse,
  sui: SuiGraphQl,
  target: string,
  threshold: bigint,
  from: FundedFrom,
  start: bigint,
) {
  let balance = start;
  for (let i = 0; i < POLL_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    balance = await sui.getBalance(target).catch(() => balance);
    if (balance >= threshold) {
      return res.status(200).json({
        funded: true,
        source: from.source,
        ...(from.digest ? { digest: from.digest, explorerTx: CHAIN.explorerTx(from.digest) } : {}),
        balanceMist: balance.toString(),
      });
    }
  }
  return res.status(504).json({
    error:
      from.source === "sponsor"
        ? `sponsor transfer ${from.digest} executed but ${target} still holds ${fmtSui(balance)} after ${(POLL_TRIES * POLL_INTERVAL_MS) / 1000}s — the indexer may be behind; try again.`
        : `the faucet accepted the request but ${target} still holds ${fmtSui(balance)} after ${(POLL_TRIES * POLL_INTERVAL_MS) / 1000}s. ${manualHint(target)}`,
    ...(from.digest ? { digest: from.digest } : {}),
    balanceMist: balance.toString(),
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const body = req.body as {
      address?: string;
      minMist?: string;
      chain?: string;
    };
    const mismatch = suiChainMismatch(body?.chain, CHAIN);
    if (mismatch) return res.status(400).json({ error: mismatch });

    let target: string;
    try {
      // Strict: a 20-byte EVM address would otherwise be zero-padded into a
      // valid-looking Sui address that nobody controls, and the funds would
      // be gone with every check downstream agreeing.
      target = bytesToHex0x(parseSuiAddressStrict(String(body?.address ?? ""), "address"));
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }

    // What the address should END UP holding. A caller about to run a
    // DeepBook trade asks for more than a transfer needs. This is not
    // clamped to the per-run cap: the cap limits how much ONE top-up may
    // send, and conflating the two silently funded 0.1 SUI when 0.7 was
    // asked for and then failed further down with a confusing message.
    const threshold =
      body?.minMist != null ? BigInt(String(body.minMist)) : SUI_MIN_BALANCE_MIST;

    const sui = new SuiGraphQl(graphql());

    // Already funded? Nothing to do — makes the endpoint idempotent, so a
    // double-click or a retry cannot drain the sponsor.
    const current = await sui.getBalance(target);
    if (current >= threshold) {
      return res.status(200).json({ funded: true, balanceMist: current.toString() });
    }
    const need = threshold - current;
    const topUp = need > SUI_SPONSOR_MAX_TOPUP_MIST ? SUI_SPONSOR_MAX_TOPUP_MIST : need;

    // ---- 1. Sponsor key ----
    // Why the sponsor could not pay, if it could not, so the final error
    // explains both sources rather than only the faucet's refusal.
    let sponsorNote: string | null = null;
    const raw = (process.env.SUI_FUNDER_KEY ?? "").trim();
    if (raw) {
      // Whatever `sui keytool export` / Sui Wallet hands out (`suiprivkey1…`,
      // Ed25519 or secp256k1) or 32 bytes of secp256k1 hex. Ed25519 is the
      // default scheme, so hex-only would reject the common case.
      let key;
      try {
        key = parseSuiPrivateKey(raw);
      } catch (e) {
        return res.status(500).json({ error: `SUI_FUNDER_KEY: ${(e as Error).message}` });
      }
      const sponsor = bytesToHex0x(suiAddressFromKey(key));
      const sponsorBal = await sui.getBalance(sponsor);
      if (sponsorBal < topUp + GAS_BUDGET_MIST) {
        sponsorNote = `sponsor ${sponsor} holds ${fmtSui(sponsorBal)}, needs ${fmtSui(topUp + GAS_BUDGET_MIST)}`;
      } else {
        // Largest coins first, at most SUI_MAX_GAS_COINS; Sui merges them at
        // execution so a fragmented sponsor balance still pays. Via JSON-RPC
        // when one is configured: a wallet-funded sponsor usually holds its
        // SUI in an address balance, which owns no coin objects and so looks
        // empty to GraphQL even with tokens in it.
        const coins = (
          await fetchSpendableCoins(sponsor, { graphql: sui, rpc: rpcClient() })
        ).slice(0, SUI_MAX_GAS_COINS);
        if (coins.length === 0) {
          sponsorNote =
            `sponsor ${sponsor} reports ${fmtSui(sponsorBal)} but no spendable coin refs. ` +
            (rpcClient()
              ? "Its SUI may be mid-transaction; try again shortly."
              : `Its SUI is likely held in an address balance, which only JSON-RPC can spend from — set ${CHAIN.rpcEnv} to a provider URL.`);
        } else {
          const gasPrice = await sui.getReferenceGasPrice();
          const txBytes = encodeSuiTransactionData({
            kindBytes: encodeSuiTransferKind(parseSuiAddress(target), topUp),
            sender: parseSuiAddress(sponsor),
            gasPayment: coins.map((c) => c.ref),
            gasPrice,
            gasBudget: GAS_BUDGET_MIST,
          });
          const { serialized } = signSuiTransactionWithKey(txBytes, key);
          const exec = await sui.executeTransaction(txBytes, [serialized]);
          if (exec.status === "SUCCESS") {
            return waitForBalance(
              res,
              sui,
              target,
              threshold,
              { source: "sponsor", digest: exec.digest },
              current,
            );
          }
          sponsorNote = `sponsor transfer ${exec.digest} failed on Sui: ${exec.error ?? "unknown"}`;
        }
      }
    } else {
      sponsorNote = "SUI_FUNDER_KEY is not set";
    }

    // ---- 2. Public faucet ----
    const faucet = await requestSuiFromFaucet(CHAIN.faucet, target);
    if (faucet.ok) {
      return waitForBalance(res, sui, target, threshold, { source: "faucet" }, current);
    }
    return res.status(503).json({
      error:
        `could not fund ${target}: ${sponsorNote}; faucet ${CHAIN.faucet} ` +
        `answered ${faucet.status}${faucet.body.trim() ? ` (${faucet.body.trim()})` : ""}. ` +
        manualHint(target),
      address: target,
      faucet: CHAIN.faucet,
      balanceMist: current.toString(),
    });
  } catch (e) {
    // Say which network and GraphQL host failed, so a bad override reads as
    // what it is — the server's endpoint env var — rather than a page bug.
    const host = (() => {
      try {
        return new URL(graphql()).host;
      } catch {
        return graphql();
      }
    })();
    return res.status(500).json({
      error: `${CHAIN.name} via ${host} (${CHAIN.graphqlEnv}): ${(e as Error).message}`,
    });
  }
}
