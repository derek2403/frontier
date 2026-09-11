// Borsh decoders for the three events the relayer consumes.
//
// Anchor 0.32.1's `Program.addEventListener` doesn't resolve event fields
// when their types live in the IDL's `types` array (which is the new IDL
// spec's default), so the relayer parses "Program data: <base64>" log lines
// itself: an 8-byte discriminator from the IDL, then the borsh-encoded
// struct. These layouts are the only thing that can drift from what the
// programs emit, which is why they live apart from the subscription loop and
// are pinned by events.test.ts against Anchor's own coder.

import { PublicKey } from "@solana/web3.js";

// ---- minimal borsh reader for our event shapes ----

export class Reader {
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

/** eth_demo::EthTxRequested — the unsigned RLP the signature gets spliced into. */
export type EthTxRequested = {
  sigRequest: PublicKey;
  chainId: bigint;
  unsignedRlp: Uint8Array;
};

/** soda::SigCompleted — chain-agnostic; the cache says which envelope to build. */
export type SigCompleted = {
  sigRequest: PublicKey;
  signature: Uint8Array;
  recoveryId: number;
};

/** sui_demo::SuiTxRequested — the BCS bytes the signature gets attached to. */
export type SuiTxRequested = {
  sigRequest: PublicKey;
  /** blake2b256(0x01 || compressed foreign_pk), derived on-chain. */
  sender: Uint8Array;
  /** BCS `TransactionData`, exactly the bytes hashed into the SigRequest payload. */
  txBytes: Uint8Array;
};

export function decodeEthTxRequested(payload: Uint8Array): EthTxRequested {
  const r = new Reader(payload);
  return {
    sigRequest: r.pubkey(),
    chainId: r.u64Le(),
    unsignedRlp: r.vecU8(),
  };
}

export function decodeSigCompleted(payload: Uint8Array): SigCompleted {
  const r = new Reader(payload);
  return {
    sigRequest: r.pubkey(),
    signature: r.bytes(64),
    recoveryId: r.u8(),
  };
}

export function decodeSuiTxRequested(payload: Uint8Array): SuiTxRequested {
  const r = new Reader(payload);
  const sigRequest = r.pubkey();
  const sender = r.bytes(32);
  const txBytes = r.vecU8();
  // `slice` past the end returns fewer bytes without complaint. Truncated
  // tx_bytes would still hash to something and the recovered key would just
  // not match the sender, so the relayer would skip either way — but "decode
  // failed" is the honest log line for it.
  if (r.off !== payload.length) {
    throw new Error(`SuiTxRequested: layout needs ${r.off} bytes, body has ${payload.length}`);
  }
  return { sigRequest, sender, txBytes };
}
