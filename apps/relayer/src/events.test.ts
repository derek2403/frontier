// Decoder parity against Anchor's own coder.
//
// The relayer reads "Program data:" lines by hand (events.ts says why), so
// the one thing that can drift is the field layout. Each event is encoded
// here with the IDL's BorshCoder — the layouts Anchor derives from the
// program — and decoded with the relayer's reader. A mismatch means a
// program changed shape and the relayer would misread it live.
//
// Run: pnpm --filter relayer test   (node:test through tsx; no extra deps)

import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, type PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decodeEthTxRequested, decodeSigCompleted, decodeSuiTxRequested } from "./events";

const IDL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../contracts/target/idl");

function loadIdl(name: string): Idl | null {
  const p = resolve(IDL_DIR, `${name}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Idl) : null;
}

/** Anchor's event discriminator: sha256("event:<Name>")[..8]. */
function eventDisc(name: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(`event:${name}`).digest().subarray(0, 8));
}

function u32Le(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const sigRequest = Keypair.generate().publicKey;
const sender = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
// Longer than 255 bytes so a u8-length misread (instead of u32) would show.
const txBytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 13 + 1) & 0xff);

test("SuiTxRequested decodes a hand-built borsh body", () => {
  const body = concat(sigRequest.toBytes(), sender, u32Le(txBytes.length), txBytes);
  const ev = decodeSuiTxRequested(body);
  assert.equal(ev.sigRequest.toBase58(), sigRequest.toBase58());
  assert.deepEqual(ev.sender, sender);
  assert.deepEqual(ev.txBytes, txBytes);
});

test("SuiTxRequested rejects a truncated or padded body", () => {
  const body = concat(sigRequest.toBytes(), sender, u32Le(txBytes.length), txBytes);
  assert.throws(() => decodeSuiTxRequested(body.subarray(0, body.length - 1)), /layout needs/);
  assert.throws(() => decodeSuiTxRequested(concat(body, Uint8Array.from([0]))), /layout needs/);
});

const suiIdl = loadIdl("sui_demo");
test(
  "SuiTxRequested matches Anchor's coder for the sui_demo IDL",
  { skip: suiIdl ? false : "contracts/target/idl/sui_demo.json not built" },
  () => {
    const coder = new BorshCoder(suiIdl!);
    const encoded = coder.types.encode("SuiTxRequested", {
      sig_request: sigRequest,
      sender: Array.from(sender),
      tx_bytes: Buffer.from(txBytes),
    });
    const ev = decodeSuiTxRequested(Uint8Array.from(encoded));
    assert.equal(ev.sigRequest.toBase58(), sigRequest.toBase58());
    assert.deepEqual(ev.sender, sender);
    assert.deepEqual(ev.txBytes, txBytes);

    // The discriminator the relayer takes from the IDL is the one Anchor
    // derives, and Anchor's own event decoder reads the same "Program data:"
    // line the relayer would see.
    const disc = Uint8Array.from(suiIdl!.events!.find((e) => e.name === "SuiTxRequested")!.discriminator);
    assert.deepEqual(disc, eventDisc("SuiTxRequested"));
    const line = Buffer.concat([disc, encoded]).toString("base64");
    const byAnchor = coder.events.decode(line);
    assert.equal(byAnchor?.name, "SuiTxRequested");
    assert.equal((byAnchor!.data as { sig_request: PublicKey }).sig_request.toBase58(), sigRequest.toBase58());
  },
);

const ethIdl = loadIdl("eth_demo");
test(
  "EthTxRequested matches Anchor's coder for the eth_demo IDL",
  { skip: ethIdl ? false : "contracts/target/idl/eth_demo.json not built" },
  () => {
    const coder = new BorshCoder(ethIdl!);
    const rlp = Uint8Array.from({ length: 300 }, (_, i) => (i * 5 + 2) & 0xff);
    const encoded = coder.types.encode("EthTxRequested", {
      sig_request: sigRequest,
      chain_id: new BN(84_532),
      unsigned_rlp: Buffer.from(rlp),
    });
    const ev = decodeEthTxRequested(Uint8Array.from(encoded));
    assert.equal(ev.sigRequest.toBase58(), sigRequest.toBase58());
    assert.equal(ev.chainId, 84_532n);
    assert.deepEqual(ev.unsignedRlp, rlp);
    assert.deepEqual(
      Uint8Array.from(ethIdl!.events!.find((e) => e.name === "EthTxRequested")!.discriminator),
      eventDisc("EthTxRequested"),
    );
  },
);

const sodaIdl = loadIdl("soda");
test(
  "SigCompleted matches Anchor's coder for the soda IDL",
  { skip: sodaIdl ? false : "contracts/target/idl/soda.json not built" },
  () => {
    const coder = new BorshCoder(sodaIdl!);
    const signature = Uint8Array.from({ length: 64 }, (_, i) => (i * 3 + 9) & 0xff);
    const encoded = coder.types.encode("SigCompleted", {
      sig_request: sigRequest,
      signature: Array.from(signature),
      recovery_id: 1,
    });
    const ev = decodeSigCompleted(Uint8Array.from(encoded));
    assert.equal(ev.sigRequest.toBase58(), sigRequest.toBase58());
    assert.deepEqual(ev.signature, signature);
    assert.equal(ev.recoveryId, 1);
    assert.deepEqual(
      Uint8Array.from(sodaIdl!.events!.find((e) => e.name === "SigCompleted")!.discriminator),
      eventDisc("SigCompleted"),
    );
  },
);
