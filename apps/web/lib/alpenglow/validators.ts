// The SIMULATED Alpenglow validator set: 1,000 BLS12-381 keys with random-
// looking stake. Real Alpenglow validators register BLS keys on Solana
// (SIMD-0387), but nothing yet carries their certificates to another chain,
// so this demo signs certificates with keys it made itself.
//
// The keys come from SEPOLIA_FUNDER_KEY, so the server can rebuild the set
// on every start and nobody without that key can forge a certificate for the
// demo light client. Used by the API routes and by scripts/alpenglow-deploy.ts.

import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { concatHex, encodePacked, keccak256, toHex, type Hex } from "viem";

export const DST = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
export const N_VALIDATORS = 1000;
export const THRESHOLD_PCT = 60;

const R = bls.fields.Fr.ORDER;
export const G1 = bls.G1.ProjectivePoint;
type G1Point = InstanceType<typeof bls.G1.ProjectivePoint>;
type G2Point = InstanceType<typeof bls.G2.ProjectivePoint>;

// EIP-2537 encoding: each base-field element is 64 bytes, big endian.
const fp = (x: bigint) => x.toString(16).padStart(128, "0");
export const g1Hex = (P: G1Point): Hex => {
  const a = P.toAffine();
  return `0x${fp(a.x)}${fp(a.y)}`;
};
export const g2Hex = (P: G2Point): Hex => {
  const a = P.toAffine();
  return `0x${fp(a.x.c0)}${fp(a.x.c1)}${fp(a.y.c0)}${fp(a.y.c1)}`;
};

const sortedHash = (a: Hex, b: Hex) =>
  BigInt(a) < BigInt(b) ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));

export function merkle(leaves: Hex[]) {
  const levels: Hex[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? sortedHash(cur[i], cur[i + 1]) : cur[i]);
    }
    levels.push(next);
  }
  const proof = (idx: number) => {
    const p: Hex[] = [];
    for (let l = 0; l < levels.length - 1; l++) {
      const sib = idx ^ 1;
      if (sib < levels[l].length) p.push(levels[l][sib]);
      idx >>= 1;
    }
    return p;
  };
  return { root: levels[levels.length - 1][0], proof };
}

export type Validator = { sk: bigint; stake: bigint; pk: G1Point; pkHex: Hex; leaf: Hex };
export type ValidatorSet = {
  vals: Validator[];
  totalStake: bigint;
  aggPk: G1Point;
  root: Hex;
  proof: (i: number) => Hex[];
};

export function buildValidatorSet(funderKeyHex: string): ValidatorSet {
  const key = funderKeyHex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("SEPOLIA_FUNDER_KEY is not a 32-byte hex key");
  const seed = keccak256(concatHex([toHex("SODA-alpenglow-sim-validators"), `0x${key}`]));
  const vals: Validator[] = [];
  let totalStake = 0n;
  let aggPk = G1.ZERO;
  for (let i = 0; i < N_VALIDATORS; i++) {
    const h = keccak256(encodePacked(["bytes32", "uint32", "string"], [seed, i, "sk"]));
    const sk = (BigInt(h) % (R - 1n)) + 1n;
    const s = keccak256(encodePacked(["bytes32", "uint32", "string"], [seed, i, "stake"]));
    const stake = 1000n + (BigInt(s) % 99_000n);
    const pk = G1.BASE.multiply(sk);
    const pkHex = g1Hex(pk);
    const leaf = keccak256(encodePacked(["bytes", "uint64"], [pkHex, stake]));
    vals.push({ sk, stake, pk, pkHex, leaf });
    totalStake += stake;
    aggPk = aggPk.add(pk);
  }
  const tree = merkle(vals.map((v) => v.leaf));
  return { vals, totalStake, aggPk, root: tree.root, proof: tree.proof };
}

export function certificateMessage(blockId: Hex, approvalsRoot: Hex): Uint8Array {
  const prefix = new TextEncoder().encode("SODA-alpenglow-sim");
  const out = new Uint8Array(prefix.length + 64);
  out.set(prefix, 0);
  out.set(Buffer.from(blockId.slice(2), "hex"), prefix.length);
  out.set(Buffer.from(approvalsRoot.slice(2), "hex"), prefix.length + 32);
  return out;
}

/**
 * Signs (blockId, approvalsRoot) as if every validator except `nonSignerCount`
 * of them voted. The aggregate signature equals the sum of the signers'
 * individual BLS signatures; the server computes it from the summed secret
 * key in one step instead of 1,000 signatures, which gives the same bytes.
 */
export function signCertificate(set: ValidatorSet, blockId: Hex, approvalsRoot: Hex, nonSignerCount: number) {
  // Spread the non-signers over the set, deterministic per block.
  const picked = new Set<number>();
  let x = BigInt(blockId);
  while (picked.size < nonSignerCount) {
    x = BigInt(keccak256(toHex(x, { size: 32 })));
    picked.add(Number(x % BigInt(N_VALIDATORS)));
  }
  let signerSk = 0n;
  let missing = 0n;
  set.vals.forEach((v, i) => {
    if (picked.has(i)) missing += v.stake;
    else signerSk = (signerSk + v.sk) % R;
  });
  const H = bls.G2.hashToCurve(certificateMessage(blockId, approvalsRoot), { DST }) as unknown as G2Point;
  const sig = H.multiply(signerSk);
  const nonSigners = [...picked]
    .map((i) => ({ pk: set.vals[i].pkHex, stake: set.vals[i].stake, proof: set.proof(i), leaf: set.vals[i].leaf }))
    .sort((a, b) => (BigInt(a.leaf) < BigInt(b.leaf) ? -1 : 1))
    .map(({ pk, stake, proof }) => ({ pk, stake, proof }));
  const signedStakePct = Number(((set.totalStake - missing) * 10_000n) / set.totalStake) / 100;
  return { sig: g2Hex(sig), nonSigners, signedStakePct };
}
