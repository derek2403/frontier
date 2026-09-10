// Parity vs. the official @mysten/sui SDK (devDependency only) and vs. the
// Rust twin in contracts/programs/sui_demo/src/sui_bcs.rs, whose vectors
// were produced by the same SDK calls.

import { describe, expect, test } from "vitest";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { toBase58 as mystenToBase58, toBase64 as mystenToBase64 } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import { secp256k1 } from "@noble/curves/secp256k1";

import { computeTweak, ETH_SEPOLIA_CHAIN_TAG } from "./derive";
import {
  bech32Decode,
  bytesToHex0x,
  compressPk,
  decodeSuiSignature,
  deriveSuiAddress,
  parseSuiPrivateKey,
  signSuiTransactionWithKey,
  suiAddressFromKey,
  encodeSuiSignature,
  encodeSuiTransactionData,
  encodeSuiTransferKind,
  fromBase58,
  fromBase64,
  getSuiChain,
  parseSuiAddress,
  signSuiTransactionWithSecp256k1,
  SUI_CHAINS,
  suiAddressFromPk,
  suiIntentDigest,
  suiSigningPayload,
  suiTransactionDigest,
  toBase58,
  toBase64,
} from "./sui";

function unhex(s: string): Uint8Array {
  const clean = s.replace(/\s|0x/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const SK = new Uint8Array(32).fill(7);
const KP = Secp256k1Keypair.fromSecretKey(SK);
const ADDR = KP.toSuiAddress();
const RECIPIENT = "0x" + "33".repeat(32);
const GAS = { objectId: "0x" + "11".repeat(32), version: 5, digest: mystenToBase58(new Uint8Array(32).fill(0x22)) };
const GAS2 = { objectId: "0x" + "44".repeat(32), version: 77, digest: mystenToBase58(new Uint8Array(32).fill(0x55)) };

function mystenTransfer(gas: Array<typeof GAS>, opts: { gasOwner?: string } = {}) {
  const tx = new Transaction();
  tx.setSender(ADDR);
  if (opts.gasOwner) tx.setGasOwner(opts.gasOwner);
  tx.setGasPayment(gas);
  tx.setGasPrice(1000);
  tx.setGasBudget(5_000_000);
  const [coin] = tx.splitCoins(tx.gas, [1_000_000]);
  tx.transferObjects([coin], RECIPIENT);
  return tx;
}

function ref(r: typeof GAS) {
  return { objectId: parseSuiAddress(r.objectId), version: BigInt(r.version), digest: fromBase58(r.digest) };
}

describe("Sui address", () => {
  test("blake2b256(0x01 || compressed pk) matches Secp256k1Keypair.toSuiAddress", () => {
    for (const fill of [1, 7, 42, 200]) {
      const sk = new Uint8Array(32).fill(fill);
      const expected = Secp256k1Keypair.fromSecretKey(sk).toSuiAddress();
      const compressed = secp256k1.getPublicKey(sk, true);
      const uncompressed = secp256k1.getPublicKey(sk, false);
      expect(bytesToHex0x(suiAddressFromPk(compressed))).toBe(expected);
      expect(bytesToHex0x(suiAddressFromPk(uncompressed))).toBe(expected);
    }
  });

  test("matches the Rust vector", () => {
    expect(bytesToHex0x(suiAddressFromPk(unhex("02989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f")))).toBe(
      "0x3334442090548419b94695cbb1838652bb0494b54ff855494dd83491a3cfb6a6",
    );
  });

  test("compressPk rejects other lengths", () => {
    expect(() => compressPk(new Uint8Array(20))).toThrow();
  });

  test("deriveSuiAddress is deterministic and chain-tag separated", () => {
    const groupPk = secp256k1.getPublicKey(SK, true);
    const owner = new Uint8Array(32).fill(9);
    const a = deriveSuiAddress(groupPk, owner, new Uint8Array(0), SUI_CHAINS["sui-testnet"].chainTag);
    const b = deriveSuiAddress(groupPk, owner, new Uint8Array(0), SUI_CHAINS["sui-testnet"].chainTag);
    expect(a.suiAddress).toEqual(b.suiAddress);
    expect(a.tweak).toEqual(computeTweak(owner, new Uint8Array(0), SUI_CHAINS["sui-testnet"].chainTag));
    // Same owner, EVM tag → different tweak → different key. The primitive
    // gives every owner a distinct address per chain.
    const evm = computeTweak(owner, new Uint8Array(0), ETH_SEPOLIA_CHAIN_TAG);
    expect(a.tweak).not.toEqual(evm);
    expect(deriveSuiAddress(groupPk, owner, new Uint8Array(0), SUI_CHAINS["sui-devnet"].chainTag).suiAddress).not.toEqual(a.suiAddress);
  });

  test("parseSuiAddress pads short forms and rejects junk", () => {
    expect(bytesToHex0x(parseSuiAddress("0x2"))).toBe("0x" + "0".repeat(63) + "2");
    expect(parseSuiAddress(RECIPIENT)).toEqual(new Uint8Array(32).fill(0x33));
    expect(() => parseSuiAddress("0xzz")).toThrow();
    expect(() => parseSuiAddress("0x" + "1".repeat(65))).toThrow();
  });
});

describe("BCS encoding", () => {
  test("transfer kind matches Transaction.build({ onlyTransactionKind })", async () => {
    const kind = await mystenTransfer([GAS]).build({ onlyTransactionKind: true });
    expect(encodeSuiTransferKind(parseSuiAddress(RECIPIENT), 1_000_000n)).toEqual(kind);
  });

  test("envelope matches Transaction.build() with one gas coin", async () => {
    const full = await mystenTransfer([GAS]).build();
    const mine = encodeSuiTransactionData({
      kindBytes: encodeSuiTransferKind(parseSuiAddress(RECIPIENT), 1_000_000n),
      sender: parseSuiAddress(ADDR),
      gasPayment: [ref(GAS)],
      gasPrice: 1000n,
      gasBudget: 5_000_000n,
    });
    expect(mine).toEqual(full);
  });

  test("envelope matches with two gas coins", async () => {
    const full = await mystenTransfer([GAS, GAS2]).build();
    const mine = encodeSuiTransactionData({
      kindBytes: encodeSuiTransferKind(parseSuiAddress(RECIPIENT), 1_000_000n),
      sender: parseSuiAddress(ADDR),
      gasPayment: [ref(GAS), ref(GAS2)],
      gasPrice: 1000n,
      gasBudget: 5_000_000n,
    });
    expect(mine).toEqual(full);
  });

  test("a separate gas owner (sponsored) matches setGasOwner", async () => {
    const sponsor = "0x" + "77".repeat(32);
    const full = await mystenTransfer([GAS], { gasOwner: sponsor }).build();
    const mine = encodeSuiTransactionData({
      kindBytes: encodeSuiTransferKind(parseSuiAddress(RECIPIENT), 1_000_000n),
      sender: parseSuiAddress(ADDR),
      gasPayment: [ref(GAS)],
      gasOwner: parseSuiAddress(sponsor),
      gasPrice: 1000n,
      gasBudget: 5_000_000n,
    });
    expect(mine).toEqual(full);
  });

  test("an arbitrary PTB kind from the SDK wraps to the SDK's full bytes", async () => {
    // Two transfers + a merge: not the shape encodeSuiTransferKind produces,
    // which is the point of sign_sui_tx.
    const tx = new Transaction();
    tx.setSender(ADDR);
    tx.setGasPayment([GAS]);
    tx.setGasPrice(1000);
    tx.setGasBudget(7_000_000);
    const [a, b] = tx.splitCoins(tx.gas, [1, 2]);
    tx.transferObjects([a], RECIPIENT);
    tx.transferObjects([b], "0x" + "99".repeat(32));
    const kind = await tx.build({ onlyTransactionKind: true });
    const full = await tx.build();
    expect(
      encodeSuiTransactionData({
        kindBytes: kind,
        sender: parseSuiAddress(ADDR),
        gasPayment: [ref(GAS)],
        gasPrice: 1000n,
        gasBudget: 7_000_000n,
      }),
    ).toEqual(full);
  });

  test("refuses a non-programmable kind and an empty gas list", () => {
    const base = {
      kindBytes: encodeSuiTransferKind(parseSuiAddress(RECIPIENT), 1n),
      sender: parseSuiAddress(ADDR),
      gasPayment: [ref(GAS)],
      gasPrice: 1n,
      gasBudget: 1n,
    };
    expect(() => encodeSuiTransactionData({ ...base, kindBytes: Uint8Array.from([1, 2, 3]) })).toThrow();
    expect(() => encodeSuiTransactionData({ ...base, gasPayment: [] })).toThrow();
  });
});

describe("hashing and signatures", () => {
  test("Rust vector: intent digest and signing payload", () => {
    const full = unhex(
      "000002000840420f00000000000020333333333333333333333333333333333333333333333333333333333333333302020001010000010103000000000101003334442090548419b94695cbb1838652bb0494b54ff855494dd83491a3cfb6a601111111111111111111111111111111111111111111111111111111111111111105000000000000002022222222222222222222222222222222222222222222222222222222222222223334442090548419b94695cbb1838652bb0494b54ff855494dd83491a3cfb6a6e803000000000000404b4c000000000000",
    );
    expect(suiIntentDigest(full)).toEqual(unhex("72ffe4a0f6d4258326f48bfeef7e0e58dddaa1b21d8319c16474cc252b1faaec"));
    expect(suiSigningPayload(full)).toEqual(unhex("e9fb38bd6193c0a9b9d3bb800364c5ece94f42823238f1899ef0aed2b17de667"));
    expect(suiTransactionDigest(full)).toBe("DgY8tq1ETaqXhrDU9wxHbNk75RNBNpdd7amwpeZU4u9p");
  });

  test("signing sha256(blake2b(intent || tx)) reproduces Secp256k1Keypair.signTransaction", async () => {
    const tx = mystenTransfer([GAS]);
    const bytes = await tx.build();
    const { signature } = await KP.signTransaction(bytes);
    const theirs = fromBase64(signature);

    const payload = suiSigningPayload(bytes);
    const sig = secp256k1.sign(payload, SK, { lowS: true });
    const mine = encodeSuiSignature(sig.toCompactRawBytes(), secp256k1.getPublicKey(SK, true));
    expect(mine).toEqual(theirs);
    expect(toBase64(mine)).toBe(signature);

    // and the recovery path finalize_signature takes on-chain
    const recovered = sig.recoverPublicKey(payload).toRawBytes(false);
    expect(bytesToHex0x(suiAddressFromPk(recovered))).toBe(ADDR);
  });

  test("signSuiTransactionWithSecp256k1 output verifies with @mysten/sui and names the sender", async () => {
    const bytes = await mystenTransfer([GAS]).build();
    const { signatureB64 } = signSuiTransactionWithSecp256k1(bytes, SK);
    const pk = await verifyTransactionSignature(bytes, signatureB64);
    expect(pk.toSuiAddress()).toBe(ADDR);
    const decoded = decodeSuiSignature(fromBase64(signatureB64));
    expect(decoded.flag).toBe(1);
    expect(decoded.publicKey).toEqual(secp256k1.getPublicKey(SK, true));
  });

  test("transaction digest matches Transaction.getDigest", async () => {
    const tx = mystenTransfer([GAS, GAS2]);
    const bytes = await tx.build();
    expect(suiTransactionDigest(bytes)).toBe(await tx.getDigest());
  });

  test("decodeSuiSignature rejects other schemes", () => {
    const ed = new Uint8Array(97); // flag 0x00 || sig64 || pk32
    expect(() => decodeSuiSignature(ed)).toThrow();
  });
});

describe("local sponsor keys", () => {
  test("suiprivkey1… Ed25519 export decodes like decodeSuiPrivateKey and signs identically", async () => {
    const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(5));
    const exported = kp.getSecretKey();
    const theirs = decodeSuiPrivateKey(exported);
    const mine = parseSuiPrivateKey(exported);
    expect(mine.scheme).toBe("ed25519");
    expect(mine.secretKey).toEqual(theirs.secretKey);
    expect(bytesToHex0x(suiAddressFromKey(mine))).toBe(kp.toSuiAddress());

    const bytes = await mystenTransfer([GAS]).build();
    const { signature } = await kp.signTransaction(bytes);
    const { signatureB64, serialized } = signSuiTransactionWithKey(bytes, mine);
    expect(signatureB64).toBe(signature); // Ed25519 is deterministic
    expect(serialized.length).toBe(97);
    const pk = await verifyTransactionSignature(bytes, signatureB64);
    expect(pk.toSuiAddress()).toBe(kp.toSuiAddress());
  });

  test("suiprivkey1… secp256k1 export and raw hex both mean secp256k1", async () => {
    const exported = KP.getSecretKey();
    const fromBech32 = parseSuiPrivateKey(exported);
    expect(fromBech32.scheme).toBe("secp256k1");
    expect(fromBech32.secretKey).toEqual(SK);
    const fromHex = parseSuiPrivateKey("0x" + "07".repeat(32));
    expect(fromHex).toEqual(fromBech32);
    expect(bytesToHex0x(suiAddressFromKey(fromHex))).toBe(ADDR);

    const bytes = await mystenTransfer([GAS]).build();
    const { signature } = await KP.signTransaction(bytes);
    expect(signSuiTransactionWithKey(bytes, fromHex).signatureB64).toBe(signature);
  });

  test("rejects junk, wrong hrp, bad checksum and secp256r1", () => {
    expect(() => parseSuiPrivateKey("hello")).toThrow();
    expect(() => parseSuiPrivateKey("0x" + "ab".repeat(31))).toThrow();
    const good = Ed25519Keypair.generate().getSecretKey();
    const flipped = good.slice(0, -1) + (good.endsWith("q") ? "p" : "q");
    expect(() => parseSuiPrivateKey(flipped)).toThrow(/checksum/);
    // BIP-173 bech32 vectors (plain data, not segwit: those carry a
    // witness-version word that is not part of the byte payload).
    const v = bech32Decode("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw");
    expect(v.hrp).toBe("abcdef");
    expect(v.data.length).toBe(20); // words 0..31 = 160 bits
    expect(bech32Decode("ABCDEF1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LMQQQXW").data).toEqual(v.data);
    expect(bech32Decode("A12UEL5L").data.length).toBe(0);
    expect(() => bech32Decode("Abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw")).toThrow(/mixed case/);
    expect(() => bech32Decode("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxx")).toThrow(/checksum/);
  });
});

describe("encodings", () => {
  test("base58 round-trips and matches @mysten/sui", () => {
    const samples = [new Uint8Array(32).fill(0x22), Uint8Array.from([0, 0, 1, 2, 3]), new Uint8Array(0), Uint8Array.from([255, 255])];
    for (const s of samples) {
      expect(toBase58(s)).toBe(mystenToBase58(s));
      expect(fromBase58(toBase58(s))).toEqual(s);
    }
    expect(() => fromBase58("0OIl")).toThrow();
  });

  test("base64 round-trips and matches @mysten/sui", () => {
    const s = Uint8Array.from({ length: 1000 }, (_, i) => (i * 31) & 0xff);
    expect(toBase64(s)).toBe(mystenToBase64(s));
    expect(fromBase64(toBase64(s))).toEqual(s);
  });
});

describe("chain registry", () => {
  test("defaults to testnet and rejects unknown keys", () => {
    expect(getSuiChain(undefined).key).toBe("sui-testnet");
    expect(getSuiChain("SUI-DEVNET").key).toBe("sui-devnet");
    expect(() => getSuiChain("base-sepolia")).toThrow();
  });

  test("chain tags are 32 bytes and distinct from the EVM tags", () => {
    for (const c of Object.values(SUI_CHAINS)) {
      expect(c.chainTag.length).toBe(32);
      expect(c.chainTag).not.toEqual(ETH_SEPOLIA_CHAIN_TAG);
    }
  });
});
