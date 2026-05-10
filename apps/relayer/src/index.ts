// SODA relayer.
//
// Subscribes to two events on Solana:
//   - eth_demo::EthTxRequested  (sig_request, chain_id, unsigned_rlp)
//   - soda::SigCompleted        (sig_request, signature, recovery_id)
//
// Caches EthTxRequested by sig_request pubkey. On SigCompleted, looks up the
// cached unsigned RLP, decodes it, re-encodes with the signature + EIP-155 v,
// and POSTs eth_sendRawTransaction to Sepolia. Prints the resulting Etherscan
// link.
//
// Idempotent: Sepolia returns "already known" if the same tx was already
// broadcast (e.g. by `apps/demo`). The relayer logs and continues.
//
// Manual event decoding: Anchor 0.32.1's `Program.addEventListener` doesn't
// resolve event fields when their types live in the IDL's `types` array
// (which is the new IDL spec's default), so we parse "Program data: <base64>"
// log lines ourselves. Discriminators come from the IDL.
//
// Usage:
//   pnpm --filter relayer dev
//   RELAYER_DEBUG=1 pnpm --filter relayer dev   — log every WS log batch

import { Connection, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeUnsignedLegacy,
  eip155V,
  encodeSignedLegacy,
  EthRpc,
} from "@soda-sdk/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const SODA_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/soda.json");
const ETH_DEMO_IDL_PATH = resolve(REPO_ROOT, "contracts/target/idl/eth_demo.json");

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

// ---- minimal borsh reader for our two event shapes ----

class Reader {
  constructor(public buf: Uint8Array, public off = 0) {}
  pubkey(): PublicKey {
    const b = this.buf.subarray(this.off, this.off + 32);
    this.off += 32;
    return new PublicKey(b);
  }
  u64Le(): bigint {
    let n = 0n;
    for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(this.buf[this.off + i]);
    this.off += 8;
    return n;
  }
  u8(): number {
    return this.buf[this.off++];
  }
  bytes(len: number): Uint8Array {
    const out = this.buf.slice(this.off, this.off + len);
    this.off += len;
    return out;
  }
  vecU8(): Uint8Array {
    const len = Number(this.u32Le());
    return this.bytes(len);
  }
  u32Le(): bigint {
    let n = 0n;
    for (let i = 3; i >= 0; i--) n = (n << 8n) | BigInt(this.buf[this.off + i]);
    this.off += 4;
    return n;
  }
}

type EthTxRequested = {
  sigRequest: PublicKey;
  chainId: bigint;
  unsignedRlp: Uint8Array;
};
type SigCompleted = {
  sigRequest: PublicKey;
  signature: Uint8Array;
  recoveryId: number;
};

function decodeEthTxRequested(payload: Uint8Array): EthTxRequested {
  const r = new Reader(payload);
  return {
    sigRequest: r.pubkey(),
    chainId: r.u64Le(),
    unsignedRlp: r.vecU8(),
  };
}
function decodeSigCompleted(payload: Uint8Array): SigCompleted {
  const r = new Reader(payload);
  return {
    sigRequest: r.pubkey(),
    signature: r.bytes(64),
    recoveryId: r.u8(),
  };
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

  const connection = new Connection(SOLANA_RPC, "confirmed");
  const sepolia = new EthRpc(SEPOLIA_RPC);

  console.log(`${C.cyan}┏━ SODA relayer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${C.reset}`);
  console.log(`${C.cyan}┃${C.reset}  Solana RPC:   ${SOLANA_RPC.split("?")[0]}`);
  console.log(`${C.cyan}┃${C.reset}  Sepolia RPC:  ${SEPOLIA_RPC.split("?")[0]}`);
  console.log(`${C.cyan}┃${C.reset}  SODA program: ${sodaProgramId.toBase58()}`);
  console.log(`${C.cyan}┃${C.reset}  eth_demo:     ${ethDemoProgramId.toBase58()}`);
  console.log(`${C.cyan}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${C.reset}`);

  const cache = new Map<string, CachedTx>();
  const debug = process.env.RELAYER_DEBUG === "1";
  // Track txs we've already parsed so the two onLogs subscriptions (one per
  // program ID) don't double-process a CPI that mentions both.
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
    const cached = cache.get(event.sigRequest.toBase58());
    if (!cached) {
      log(`  ${C.yellow}no EthTxRequested cached for this SigCompleted — was the relayer started after sign_eth_transfer?${C.reset}`);
      return;
    }
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

  connection.onLogs(sodaProgramId, (logs) => {
    processLogs("soda", logs).catch((e) => log(`  ${C.red}soda onLogs handler crashed:${C.reset} ${(e as Error).message}`));
  });
  connection.onLogs(ethDemoProgramId, (logs) => {
    processLogs("eth_demo", logs).catch((e) => log(`  ${C.red}eth_demo onLogs handler crashed:${C.reset} ${(e as Error).message}`));
  });

  log(`watching for events… (Ctrl-C to stop)`);
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`${C.red}✗ relayer crashed:${C.reset}`, e?.message ?? e);
  process.exit(1);
});
