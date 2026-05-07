// SODA RLP — TS port of contracts/programs/eth_demo/src/eth_rlp.rs,
// plus the signed-tx assembler (legacy + EIP-155 v) for broadcast.

function trimLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.subarray(i);
}

function encodeBytes(bytes: Uint8Array, out: number[]): void {
  if (bytes.length === 1 && bytes[0] < 0x80) {
    out.push(bytes[0]);
  } else if (bytes.length <= 55) {
    out.push(0x80 + bytes.length);
    for (const b of bytes) out.push(b);
  } else if (bytes.length <= 255) {
    out.push(0xb8);
    out.push(bytes.length);
    for (const b of bytes) out.push(b);
  } else {
    throw new Error(`bytes too long: ${bytes.length}`);
  }
}

function encodeU64(n: bigint, out: number[]): void {
  const buf = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    buf[7 - i] = Number((n >> BigInt(i * 8)) & 0xffn);
  }
  encodeBytes(trimLeadingZeros(buf), out);
}

function encodeBigBE(value: Uint8Array, out: number[]): void {
  encodeBytes(trimLeadingZeros(value), out);
}

function wrapList(payload: number[]): Uint8Array {
  const head: number[] = [];
  if (payload.length <= 55) {
    head.push(0xc0 + payload.length);
  } else if (payload.length <= 255) {
    head.push(0xf8, payload.length);
  } else if (payload.length <= 0xffff) {
    head.push(0xf9, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    throw new Error(`list payload too long: ${payload.length}`);
  }
  return Uint8Array.from([...head, ...payload]);
}

export type LegacyTx = {
  nonce: bigint;
  gasPriceWei: bigint;
  gasLimit: bigint;
  to: Uint8Array;
  valueWeiBe: Uint8Array;
  data: Uint8Array;
  chainId: bigint;
};

/** RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]) — sighash form. */
export function encodeUnsignedLegacy(tx: LegacyTx): Uint8Array {
  const payload: number[] = [];
  encodeU64(tx.nonce, payload);
  encodeU64(tx.gasPriceWei, payload);
  encodeU64(tx.gasLimit, payload);
  encodeBytes(tx.to, payload);
  encodeBigBE(tx.valueWeiBe, payload);
  encodeBytes(tx.data, payload);
  encodeU64(tx.chainId, payload);
  encodeBytes(new Uint8Array(0), payload);
  encodeBytes(new Uint8Array(0), payload);
  return wrapList(payload);
}

/** RLP([nonce, gasPrice, gasLimit, to, value, data, v, r, s]) — broadcastable form. */
export function encodeSignedLegacy(
  base: Omit<LegacyTx, "chainId">,
  v: bigint,
  r: Uint8Array,
  s: Uint8Array,
): Uint8Array {
  const payload: number[] = [];
  encodeU64(base.nonce, payload);
  encodeU64(base.gasPriceWei, payload);
  encodeU64(base.gasLimit, payload);
  encodeBytes(base.to, payload);
  encodeBigBE(base.valueWeiBe, payload);
  encodeBytes(base.data, payload);
  encodeU64(v, payload);
  encodeBigBE(r, payload);
  encodeBigBE(s, payload);
  return wrapList(payload);
}

/** EIP-155 v: `recovery_id + 35 + 2 * chain_id`. */
export function eip155V(recoveryId: number, chainId: bigint): bigint {
  return BigInt(recoveryId) + 35n + 2n * chainId;
}

// ---------------------------------------------------------------------------
// RLP decoder (just enough to parse an unsigned legacy + EIP-155 9-field tx).
// ---------------------------------------------------------------------------

function readListHeader(b: Uint8Array, off: number): { payloadStart: number; payloadEnd: number } {
  const tag = b[off];
  if (tag >= 0xc0 && tag <= 0xf7) {
    const len = tag - 0xc0;
    return { payloadStart: off + 1, payloadEnd: off + 1 + len };
  }
  if (tag >= 0xf8 && tag <= 0xff) {
    const lenOfLen = tag - 0xf7;
    let len = 0;
    for (let i = 0; i < lenOfLen; i++) len = (len << 8) | b[off + 1 + i];
    return { payloadStart: off + 1 + lenOfLen, payloadEnd: off + 1 + lenOfLen + len };
  }
  throw new Error(`expected list header at offset ${off}, got 0x${tag.toString(16)}`);
}

function readBytes(b: Uint8Array, off: number): { value: Uint8Array; next: number } {
  const tag = b[off];
  if (tag < 0x80) {
    return { value: b.subarray(off, off + 1), next: off + 1 };
  }
  if (tag <= 0xb7) {
    const len = tag - 0x80;
    return { value: b.subarray(off + 1, off + 1 + len), next: off + 1 + len };
  }
  if (tag <= 0xbf) {
    const lenOfLen = tag - 0xb7;
    let len = 0;
    for (let i = 0; i < lenOfLen; i++) len = (len << 8) | b[off + 1 + i];
    const start = off + 1 + lenOfLen;
    return { value: b.subarray(start, start + len), next: start + len };
  }
  throw new Error(`expected bytes at offset ${off}, got 0x${tag.toString(16)} (list)`);
}

function bytesToBigIntInternal(b: Uint8Array): bigint {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}

/**
 * Decode an unsigned legacy + EIP-155 RLP tx (9 fields:
 * [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]).
 *
 * Used by the relayer to recover the tx params from the unsigned_rlp blob
 * carried by `eth_demo`'s `EthTxRequested` event, so it can re-assemble a
 * signed RLP for broadcast once the signature lands.
 */
export function decodeUnsignedLegacy(rlp: Uint8Array): LegacyTx {
  const { payloadStart, payloadEnd } = readListHeader(rlp, 0);

  let cur = payloadStart;
  const nextField = (): Uint8Array => {
    const { value, next } = readBytes(rlp, cur);
    cur = next;
    return value;
  };

  const nonceBytes = nextField();
  const gasPriceBytes = nextField();
  const gasLimitBytes = nextField();
  const toBytes = nextField();
  const valueBytes = nextField();
  const dataBytes = nextField();
  const chainIdBytes = nextField();
  const rPlaceholder = nextField();
  const sPlaceholder = nextField();

  if (cur !== payloadEnd) {
    throw new Error(`trailing bytes after 9 fields: cur=${cur} end=${payloadEnd}`);
  }
  if (rPlaceholder.length !== 0 || sPlaceholder.length !== 0) {
    throw new Error("expected r=0, s=0 in unsigned EIP-155 tx");
  }
  if (toBytes.length !== 20 && toBytes.length !== 0) {
    throw new Error(`'to' must be 20 bytes (or empty for contract-create), got ${toBytes.length}`);
  }

  // Re-pad value to the 16-byte big-endian form the encoder expects.
  if (valueBytes.length > 16) {
    throw new Error(`value too large to fit in u128: ${valueBytes.length} bytes`);
  }
  const valueWeiBe = new Uint8Array(16);
  valueWeiBe.set(valueBytes, 16 - valueBytes.length);

  return {
    nonce: bytesToBigIntInternal(nonceBytes),
    gasPriceWei: bytesToBigIntInternal(gasPriceBytes),
    gasLimit: bytesToBigIntInternal(gasLimitBytes),
    to: toBytes.length === 20 ? new Uint8Array(toBytes) : new Uint8Array(20),
    valueWeiBe,
    data: new Uint8Array(dataBytes),
    chainId: bytesToBigIntInternal(chainIdBytes),
  };
}
