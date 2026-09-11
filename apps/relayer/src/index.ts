// SODA relayer.
//
// Subscribes to three events on Solana:
//   - eth_demo::EthTxRequested  (sig_request, chain_id, unsigned_rlp)
//   - sui_demo::SuiTxRequested  (sig_request, sender, tx_bytes)
//   - soda::SigCompleted        (sig_request, signature, recovery_id)
//
// Caches each request by sig_request pubkey. On SigCompleted, the cache says
// which chain the signature is for:
//   ETH: decode the unsigned RLP, re-encode with the signature + EIP-155 v,
//        POST eth_sendRawTransaction to Sepolia. Prints the Etherscan link.
//   Sui: recover the compressed pubkey from (payload, signature, recovery_id),
//        wrap it as 0x01 || r || s || pk, executeTransaction over GraphQL.
//        Prints the Suiscan link.
//
// soda itself is chain-agnostic: same SigCompleted, same 64-byte signature.
// Only the envelope around the payload differs, and only the relayer builds
// it.
//
// Idempotent: Sepolia returns "already known" if the same tx was already
// broadcast (e.g. by `apps/demo`); Sui returns the same digest for the same
// bytes + signature, or complains that the gas coin moved on. The relayer
// logs and continues either way.
//
// Manual event decoding: Anchor 0.32.1's `Program.addEventListener` doesn't
// resolve event fields when their types live in the IDL's `types` array
// (which is the new IDL spec's default), so we parse "Program data: <base64>"
// log lines ourselves. Discriminators come from the IDL; layouts are in
// events.ts.
//
// Usage:
//   pnpm --filter relayer dev
//   RELAYER_DEBUG=1 pnpm --filter relayer dev      — log every WS log batch
//   SUI_CHAIN=sui-devnet pnpm --filter relayer dev — submit Sui txs to devnet
//                                                    (default: sui-testnet)

import { Connection, PublicKey } from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bytesToHex0x,
  decodeUnsignedLegacy,
  eip155V,
  encodeSignedLegacy,
  encodeSuiSignature,
  EthRpc,
  getSuiChain,
  SUI_CHAINS,
  suiAddressFromPk,
  SuiGraphQl,
  suiGraphqlUrl,
  suiSigningPayload,
  suiTransactionDigest,
} from "@soda-sdk/core";

import {
  decodeEthTxRequested,
  decodeSigCompleted,
  decodeSuiTxRequested,
  type SigCompleted,
  type SuiTxRequested,
} from "./events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const SODA_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/soda.json");
const ETH_DEMO_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/eth_demo.json");
const SUI_DEMO_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/sui_demo.json");

(() => {
  const envPath = resolve(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
})();

const SOLANA_RPC =
  process.env.SOLANA_RPC_URL ??
  process.env.SOLANA_DEVNET_RPC_URL ??
  "http://127.0.0.1:8899";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";

// SUI_CHAIN picks the network Sui submissions go to. SuiTxRequested carries
// no chain (only the tag went into the derivation, and Sui tx bytes don't
// name one), so this is the relayer's one piece of Sui configuration. Falls
// back to DEMO_CHAIN when that is a Sui key, so `DEMO_CHAIN=sui-devnet
// ./demo.sh` and a relayer reading the same .env land on the same network.
const SUI_CHAIN = getSuiChain(
  process.env.SUI_CHAIN ??
    ((process.env.DEMO_CHAIN ?? "").trim().toLowerCase() in SUI_CHAINS ? process.env.DEMO_CHAIN : undefined),
);
const SUI_GRAPHQL = suiGraphqlUrl(SUI_CHAIN);

const C = {
  reset: "\x1b[0m",
  dim:   "\x1b[2m",
  cyan:  "\x1b[36m",
  green: "\x1b[32m",
  red:   "\x1b[31m",
  yellow:"\x1b[33m",
};

function bytesToHex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function log(line: string) {
  console.log(`${C.dim}[${ts()}]${C.reset} ${line}`);
}

function discFromIdl(idlPath: string, eventName: string): Uint8Array {
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  const ev = (idl.events ?? []).find((e: { name: string }) => e.name === eventName);
  if (!ev) throw new Error(`event ${eventName} not in ${idlPath}`);
  return Uint8Array.from(ev.discriminator);
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Sui execution is idempotent for identical bytes + signature — resubmitting
// a finalized tx returns the same digest — but if demo-sui.ts landed it first
// the GraphQL layer can still error: the node quotes the digest back, says
// "already", or reports the gas coin's version as gone, because the tx that
// spent it is the one being resent. Everything else is a real failure.
function looksAlreadySubmitted(msg: string, digest: string): boolean {
  const m = msg.toLowerCase();
  return (
    msg.includes(digest) ||
    m.includes("already") ||
    m.includes("objectversionunavailable") ||
    m.includes("not available for consumption")
  );
}

type CachedTx = {
  sigRequest: PublicKey;
  chainId: bigint;
  unsignedRlp: Uint8Array;
};

async function main() {
  const sodaIdl = JSON.parse(readFileSync(SODA_IDL_PATH, "utf8"));
  const ethDemoIdl = JSON.parse(readFileSync(ETH_DEMO_IDL_PATH, "utf8"));
  const sodaProgramId = new PublicKey(sodaIdl.address);
  const ethDemoProgramId = new PublicKey(ethDemoIdl.address);

  const ethTxRequestedDisc = discFromIdl(ETH_DEMO_IDL_PATH, "EthTxRequested");
  const sigCompletedDisc = discFromIdl(SODA_IDL_PATH, "SigCompleted");

  // The Sui path is optional: a checkout whose `anchor build` predates
  // sui_demo still relays ETH. Both values stay null in that case and the
  // Sui branches below never fire.
  let suiDemoProgramId: PublicKey | null = null;
  let suiTxRequestedDisc: Uint8Array | null = null;
  if (existsSync(SUI_DEMO_IDL_PATH)) {
    const suiDemoIdl = JSON.parse(readFileSync(SUI_DEMO_IDL_PATH, "utf8"));
    suiDemoProgramId = new PublicKey(suiDemoIdl.address);
    suiTxRequestedDisc = discFromIdl(SUI_DEMO_IDL_PATH, "SuiTxRequested");
  }

  const connection = new Connection(SOLANA_RPC, "confirmed");
  const sepolia = new EthRpc(SEPOLIA_RPC);
  const sui = new SuiGraphQl(SUI_GRAPHQL);

  console.log(`${C.cyan}┏━ SODA relayer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${C.reset}`);
  console.log(`${C.cyan}┃${C.reset}  Solana RPC:   ${SOLANA_RPC.split("?")[0]}`);
  console.log(`${C.cyan}┃${C.reset}  Sepolia RPC:  ${SEPOLIA_RPC.split("?")[0]}`);
  console.log(`${C.cyan}┃${C.reset}  Sui GraphQL:  ${SUI_GRAPHQL.split("?")[0]}  (${SUI_CHAIN.name})`);
  console.log(`${C.cyan}┃${C.reset}  SODA program: ${sodaProgramId.toBase58()}`);
  console.log(`${C.cyan}┃${C.reset}  eth_demo:     ${ethDemoProgramId.toBase58()}`);
  console.log(`${C.cyan}┃${C.reset}  sui_demo:     ${suiDemoProgramId ? suiDemoProgramId.toBase58() : "(disabled — IDL not found)"}`);
  console.log(`${C.cyan}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${C.reset}`);
  if (!suiDemoProgramId) {
    log(`${C.yellow}sui_demo IDL missing at ${SUI_DEMO_IDL_PATH} — Sui path disabled; run \`anchor build\` in contracts/ to enable${C.reset}`);
  }

  const cache = new Map<string, CachedTx>();
  const suiCache = new Map<string, SuiTxRequested>();
  const debug = process.env.RELAYER_DEBUG === "1";
  // Track txs we've already parsed so the onLogs subscriptions (one per
  // program ID) don't double-process a CPI that mentions more than one.
  const seenTxs = new Set<string>();

  async function processLogs(programLabel: string, logs: { signature: string; logs: string[]; err: unknown }) {
    if (logs.err) return;
    if (seenTxs.has(logs.signature)) return;
    seenTxs.add(logs.signature);
    if (debug) {
      log(`${C.dim}[onLogs ${programLabel}]${C.reset} sig=${logs.signature.slice(0, 12)}… ${logs.logs.length} lines`);
    }
    for (const line of logs.logs) {
      if (!line.startsWith("Program data: ")) continue;
      const b64 = line.slice("Program data: ".length);
      let raw: Uint8Array;
      try {
        raw = Uint8Array.from(Buffer.from(b64, "base64"));
      } catch {
        continue;
      }
      if (raw.length < 8) continue;
      const disc = raw.subarray(0, 8);
      const body = raw.subarray(8);

      if (bytesEq(disc, ethTxRequestedDisc)) {
        try {
          const ev = decodeEthTxRequested(body);
          cache.set(ev.sigRequest.toBase58(), {
            sigRequest: ev.sigRequest,
            chainId: ev.chainId,
            unsignedRlp: ev.unsignedRlp,
          });
          log(`${C.yellow}EthTxRequested${C.reset} sig_request=${ev.sigRequest.toBase58()} chain_id=${ev.chainId} rlp=${ev.unsignedRlp.length}b`);
        } catch (e) {
          log(`  ${C.red}EthTxRequested decode failed:${C.reset} ${(e as Error).message}`);
        }
      } else if (suiTxRequestedDisc && bytesEq(disc, suiTxRequestedDisc)) {
        try {
          const ev = decodeSuiTxRequested(body);
          suiCache.set(ev.sigRequest.toBase58(), ev);
          log(`${C.yellow}SuiTxRequested${C.reset} sig_request=${ev.sigRequest.toBase58()} sender=${bytesToHex0x(ev.sender)} tx=${ev.txBytes.length}b`);
        } catch (e) {
          log(`  ${C.red}SuiTxRequested decode failed:${C.reset} ${(e as Error).message}`);
        }
      } else if (bytesEq(disc, sigCompletedDisc)) {
        try {
          const ev = decodeSigCompleted(body);
          await onSigCompleted(ev);
        } catch (e) {
          log(`  ${C.red}SigCompleted decode failed:${C.reset} ${(e as Error).message}`);
        }
      }
    }
  }

  async function onSigCompleted(event: SigCompleted) {
    log(`${C.green}SigCompleted${C.reset}  sig_request=${event.sigRequest.toBase58()} recovery=${event.recoveryId}`);
    const key = event.sigRequest.toBase58();
    const eth = cache.get(key);
    if (eth) return broadcastEth(event, eth);
    const suiTx = suiCache.get(key);
    if (suiTx) return submitSui(event, suiTx);
    log(`  ${C.yellow}no EthTxRequested / SuiTxRequested cached for this SigCompleted — was the relayer started after the request?${C.reset}`);
  }

  async function broadcastEth(event: SigCompleted, cached: CachedTx) {
    let decoded;
    try {
      decoded = decodeUnsignedLegacy(cached.unsignedRlp);
    } catch (e) {
      log(`  ${C.red}rlp decode failed:${C.reset} ${(e as Error).message}`);
      return;
    }
    const v = eip155V(event.recoveryId, cached.chainId);
    const signedRlp = encodeSignedLegacy(
      {
        nonce: decoded.nonce,
        gasPriceWei: decoded.gasPriceWei,
        gasLimit: decoded.gasLimit,
        to: decoded.to,
        valueWeiBe: decoded.valueWeiBe,
        data: decoded.data,
      },
      v,
      event.signature.subarray(0, 32),
      event.signature.subarray(32, 64),
    );
    const signedHex = bytesToHex(signedRlp);
    try {
      const txHash = await sepolia.sendRawTransaction(signedHex);
      log(`  ${C.green}broadcast✓${C.reset} ${txHash}`);
      log(`             https://sepolia.etherscan.io/tx/${txHash}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("already known") || msg.includes("ALREADY_EXISTS") || msg.includes("nonce too low")) {
        log(`  ${C.dim}already broadcast (probably by demo.ts) — fine${C.reset}`);
      } else {
        log(`  ${C.red}broadcast failed:${C.reset} ${msg}`);
      }
    } finally {
      cache.delete(event.sigRequest.toBase58());
    }
  }

  async function submitSui(event: SigCompleted, cached: SuiTxRequested) {
    const key = event.sigRequest.toBase58();

    // Sui's envelope needs the signer's pubkey and the event doesn't carry
    // it, so recover it from the signature the same way finalize_signature
    // did on-chain: over sha256(blake2b(intent || tx)), recomputed from the
    // cached bytes.
    const payload = suiSigningPayload(cached.txBytes);
    let pk: Uint8Array;
    try {
      pk = secp256k1.Signature.fromCompact(event.signature)
        .addRecoveryBit(event.recoveryId)
        .recoverPublicKey(payload)
        .toRawBytes(true);
    } catch (e) {
      log(`  ${C.red}pubkey recovery failed:${C.reset} ${(e as Error).message}`);
      suiCache.delete(key);
      return;
    }

    // Sui checks blake2b(0x01 || pk) == sender before the ECDSA. Doing it
    // here turns a signature over the wrong bytes into one log line instead
    // of a rejected submission to interpret.
    const sender = suiAddressFromPk(pk);
    if (!bytesEq(sender, cached.sender)) {
      log(`  ${C.red}recovered key derives ${bytesToHex0x(sender)} but the event's sender is ${bytesToHex0x(cached.sender)} — skipping${C.reset}`);
      suiCache.delete(key);
      return;
    }

    const serialized = encodeSuiSignature(event.signature, pk);
    const digest = suiTransactionDigest(cached.txBytes);
    try {
      const res = await sui.executeTransaction(cached.txBytes, [serialized]);
      if (res.status === "SUCCESS") {
        log(`  ${C.green}submitted✓${C.reset} ${res.digest}`);
      } else {
        log(`  ${C.red}executed on ${SUI_CHAIN.name} but failed:${C.reset} ${res.error ?? "unknown"}`);
      }
      log(`             ${SUI_CHAIN.explorerTx(res.digest)}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (looksAlreadySubmitted(msg, digest)) {
        log(`  ${C.dim}already submitted (probably by demo-sui.ts) — fine${C.reset}`);
        log(`             ${SUI_CHAIN.explorerTx(digest)}`);
      } else {
        log(`  ${C.red}submit failed:${C.reset} ${msg}`);
      }
    } finally {
      suiCache.delete(key);
    }
  }

  connection.onLogs(sodaProgramId, (logs) => {
    processLogs("soda", logs).catch((e) => log(`  ${C.red}soda onLogs handler crashed:${C.reset} ${(e as Error).message}`));
  });
  connection.onLogs(ethDemoProgramId, (logs) => {
    processLogs("eth_demo", logs).catch((e) => log(`  ${C.red}eth_demo onLogs handler crashed:${C.reset} ${(e as Error).message}`));
  });
  if (suiDemoProgramId) {
    connection.onLogs(suiDemoProgramId, (logs) => {
      processLogs("sui_demo", logs).catch((e) => log(`  ${C.red}sui_demo onLogs handler crashed:${C.reset} ${(e as Error).message}`));
    });
  }

  log(`watching for events… (Ctrl-C to stop)`);
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`${C.red}✗ relayer crashed:${C.reset}`, e?.message ?? e);
  process.exit(1);
});
