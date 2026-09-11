// A minimal BCS encoder for Sui programmable transaction blocks.
//
// `sui.ts` needs one fixed PTB (split the gas coin, transfer it) and
// `deepbook.ts` needs several with Move calls, owned coins and shared
// objects. Rather than hand-assemble byte arrays twice, both build on the
// primitives here.
//
// This is the Sui counterpart of `rlp.ts`: a small, exact encoder rather
// than a dependency. `@mysten/sui` would do the same job, but it is a large
// runtime dependency for a package whose whole point is that it only needs
// `@noble/*`. Every encoder here is held byte-for-byte against
// `@mysten/sui`'s own output in sui-ptb.test.ts and deepbook.test.ts, so the
// parity is checked rather than assumed.
//
// Layouts are from sui-types (ProgrammableTransaction, Command, Argument,
// CallArg, ObjectArg, TypeTag).

// ---------------------------------------------------------------------------
// BCS primitives
// ---------------------------------------------------------------------------

export function uleb128(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error(`uleb128 needs a non-negative integer, got ${n}`);
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v === 0) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return Uint8Array.from(out);
}

export function u64Le(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 out of range: ${n}`);
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function u16Le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`u16 out of range: ${n}`);
  return Uint8Array.from([n & 0xff, (n >> 8) & 0xff]);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** BCS `String` / Move `Identifier`: uleb length then UTF-8 bytes. */
export function bcsString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concatBytes(uleb128(bytes.length), bytes);
}

/** BCS `vector<u8>`: uleb length then the bytes. */
export function bcsBytes(b: Uint8Array): Uint8Array {
  return concatBytes(uleb128(b.length), b);
}

// ---------------------------------------------------------------------------
// Move types
// ---------------------------------------------------------------------------

export type MoveStructTag = {
  /** 32-byte package address. */
  address: Uint8Array;
  module: string;
  name: string;
  typeParams: MoveStructTag[];
};

/**
 * Parse `0x2::sui::SUI` (with or without type parameters) into a struct tag.
 * Generic parameters are supported one level deep, which is all any type in
 * this SDK needs; a deeper nesting throws rather than silently truncating.
 */
export function parseMoveStructTag(type: string): MoveStructTag {
  const s = type.trim();
  const lt = s.indexOf("<");
  const head = lt === -1 ? s : s.slice(0, lt);
  const params = lt === -1 ? [] : splitTypeParams(s.slice(lt + 1, s.lastIndexOf(">")));
  const parts = head.split("::");
  if (parts.length !== 3) throw new Error(`not a Move struct type: ${type}`);
  return {
    address: parseHex32(parts[0]),
    module: parts[1],
    name: parts[2],
    typeParams: params.map(parseMoveStructTag),
  };
}

function splitTypeParams(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of inner) {
    if (c === "<") depth++;
    if (c === ">") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** TypeTag::Struct — the only tag this SDK emits. */
export function encodeTypeTag(tag: MoveStructTag): Uint8Array {
  return concatBytes(
    Uint8Array.from([7]),
    tag.address,
    bcsString(tag.module),
    bcsString(tag.name),
    uleb128(tag.typeParams.length),
    ...tag.typeParams.map(encodeTypeTag),
  );
}

/** Accept `0x2`, `0x…64 hex`, padded left to 32 bytes as Sui itself does. */
export function parseHex32(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length > 64) {
    throw new Error(`not a 32-byte hex id: ${hex}`);
  }
  const padded = clean.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export type PtbArgument =
  | { kind: "gas" }
  | { kind: "input"; index: number }
  | { kind: "result"; index: number }
  | { kind: "nested"; index: number; resultIndex: number };

export const GAS_COIN: PtbArgument = { kind: "gas" };
export const input = (index: number): PtbArgument => ({ kind: "input", index });
export const result = (index: number): PtbArgument => ({ kind: "result", index });
export const nested = (index: number, resultIndex: number): PtbArgument => ({
  kind: "nested",
  index,
  resultIndex,
});

export function encodeArgument(a: PtbArgument): Uint8Array {
  switch (a.kind) {
    case "gas":
      return Uint8Array.from([0]);
    case "input":
      return concatBytes(Uint8Array.from([1]), u16Le(a.index));
    case "result":
      return concatBytes(Uint8Array.from([2]), u16Le(a.index));
    case "nested":
      return concatBytes(Uint8Array.from([3]), u16Le(a.index), u16Le(a.resultIndex));
  }
}

function encodeArgumentVec(args: PtbArgument[]): Uint8Array {
  return concatBytes(uleb128(args.length), ...args.map(encodeArgument));
}

// ---------------------------------------------------------------------------
// Inputs (CallArg)
// ---------------------------------------------------------------------------

export type PtbInput =
  /** CallArg::Pure — already-serialized BCS bytes of the value. */
  | { kind: "pure"; bytes: Uint8Array }
  /** CallArg::Object(ObjectArg::SharedObject). */
  | { kind: "shared"; objectId: Uint8Array; initialSharedVersion: bigint; mutable: boolean }
  /** CallArg::Object(ObjectArg::ImmOrOwnedObject) — an owned coin, say. */
  | { kind: "owned"; objectId: Uint8Array; version: bigint; digest: Uint8Array };

export const pureU64 = (n: bigint): PtbInput => ({ kind: "pure", bytes: u64Le(n) });
export const pureAddress = (addr: Uint8Array): PtbInput => {
  if (addr.length !== 32) throw new Error("address must be 32 bytes");
  return { kind: "pure", bytes: addr };
};
export const pureBool = (b: boolean): PtbInput => ({ kind: "pure", bytes: Uint8Array.from([b ? 1 : 0]) });

export function encodeInput(i: PtbInput): Uint8Array {
  switch (i.kind) {
    case "pure":
      return concatBytes(Uint8Array.from([0]), bcsBytes(i.bytes));
    case "shared":
      if (i.objectId.length !== 32) throw new Error("shared object id must be 32 bytes");
      return concatBytes(
        Uint8Array.from([1, 1]),
        i.objectId,
        u64Le(i.initialSharedVersion),
        Uint8Array.from([i.mutable ? 1 : 0]),
      );
    case "owned":
      if (i.objectId.length !== 32 || i.digest.length !== 32) {
        throw new Error("owned object needs a 32-byte id and a 32-byte digest");
      }
      return concatBytes(Uint8Array.from([1, 0]), i.objectId, u64Le(i.version), bcsBytes(i.digest));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type PtbCommand =
  | {
      kind: "moveCall";
      packageId: Uint8Array;
      module: string;
      function: string;
      typeArguments: MoveStructTag[];
      arguments: PtbArgument[];
    }
  | { kind: "transferObjects"; objects: PtbArgument[]; address: PtbArgument }
  | { kind: "splitCoins"; coin: PtbArgument; amounts: PtbArgument[] }
  | { kind: "mergeCoins"; destination: PtbArgument; sources: PtbArgument[] };

export function encodeCommand(c: PtbCommand): Uint8Array {
  switch (c.kind) {
    case "moveCall":
      if (c.packageId.length !== 32) throw new Error("package id must be 32 bytes");
      return concatBytes(
        Uint8Array.from([0]),
        c.packageId,
        bcsString(c.module),
        bcsString(c.function),
        uleb128(c.typeArguments.length),
        ...c.typeArguments.map(encodeTypeTag),
        encodeArgumentVec(c.arguments),
      );
    case "transferObjects":
      return concatBytes(Uint8Array.from([1]), encodeArgumentVec(c.objects), encodeArgument(c.address));
    case "splitCoins":
      return concatBytes(Uint8Array.from([2]), encodeArgument(c.coin), encodeArgumentVec(c.amounts));
    case "mergeCoins":
      return concatBytes(Uint8Array.from([3]), encodeArgument(c.destination), encodeArgumentVec(c.sources));
  }
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

/** First byte of a `TransactionKind` that is a ProgrammableTransaction. */
export const SUI_KIND_PROGRAMMABLE = 0x00;

/**
 * Encode a `TransactionKind::ProgrammableTransaction`. This is what
 * `sui_demo`'s `sign_sui_tx` takes and what the on-chain program wraps in a
 * `TransactionData` envelope with the derived address as sender.
 */
export function encodeProgrammableKind(inputs: PtbInput[], commands: PtbCommand[]): Uint8Array {
  return concatBytes(
    Uint8Array.from([SUI_KIND_PROGRAMMABLE]),
    uleb128(inputs.length),
    ...inputs.map(encodeInput),
    uleb128(commands.length),
    ...commands.map(encodeCommand),
  );
}

/**
 * Small helper for building a block while keeping input indices straight:
 * `add` returns the argument that refers to what was just added.
 */
export class PtbBuilder {
  private readonly inputs: PtbInput[] = [];
  private readonly commands: PtbCommand[] = [];

  addInput(i: PtbInput): PtbArgument {
    this.inputs.push(i);
    return input(this.inputs.length - 1);
  }

  /** Adds a command and returns its `Result` argument. */
  addCommand(c: PtbCommand): PtbArgument {
    this.commands.push(c);
    return result(this.commands.length - 1);
  }

  /** Index of the last command, for building `NestedResult` arguments. */
  get lastCommandIndex(): number {
    return this.commands.length - 1;
  }

  build(): Uint8Array {
    return encodeProgrammableKind(this.inputs, this.commands);
  }
}

/**
 * `process.env` where there is one, an empty object where there is not.
 *
 * A bare `process.env` default throws `ReferenceError: process is not
 * defined` in a Vite or Rollup browser bundle. Next injects a shim so it
 * happens to work there, which is exactly how this survives until someone
 * uses the package outside Next.
 */
export function safeEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}
