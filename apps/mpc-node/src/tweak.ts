/**
 * Signing for a SODA-derived address with an untweaked Lindell '17 committee.
 *
 * SODA derives a foreign address as `foreign_pk = group_pk + t*G`, so a
 * signature has to come from the private key `x + t`, where `x` is the
 * committee's joint secret. The obvious approach — add `t` to a share — does
 * not work here: Safeheron shares the key MULTIPLICATIVELY (`Q = x1*x2*G`)
 * and P2 holds `cypher_x1`, a Paillier encryption of `x1` fixed at DKG. P1
 * cannot change what that ciphertext says, which is why the old
 * `applyTweakP1` was a silent no-op.
 *
 * The fix does not touch the protocol at all. ECDSA is
 *
 *     s = k^-1 (m + r*d)
 *
 * so for the derived key `d = x + t`:
 *
 *     s = k^-1 (m + r*x + r*t) = k^-1 ((m + r*t) + r*x)
 *
 * which is exactly the signature the UNTWEAKED committee produces for the
 * message `m* = m + r*t`. So both parties sign `m*` instead of `m`, and the
 * result is a valid signature for `group_pk + t*G` on the real payload `m`.
 *
 * This works because `r` is fixed by `R = k1*k2*G` in the first three
 * protocol messages, and neither party reads the message until after that:
 * P2 first uses it in `step2`, P1 only in `step3`. Both compute `r`
 * independently from state they already hold, so neither has to trust the
 * coordinator, and a disagreement about `t` makes P1's own signature check
 * fail rather than producing a wrong signature.
 *
 * Recovery is unaffected. `secp256k1_recover(m, r, s, v)` returns
 * `r^-1 (s*R - m*G)`, and substituting `s` above gives `group_pk + t*G`
 * for the real `m`. The chain therefore recovers exactly the `foreign_pk_xy`
 * it stored, with the same `v` the protocol computed.
 */
import BN from 'bn.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'

const N = secp256k1.Point.Fn.ORDER

/**
 * `m* = m + r*t mod n` — the message the committee actually signs so that the
 * signature belongs to `group_pk + t*G`.
 */
export function tweakedMessage(m: BN, r: bigint, tweakHex: string): BN {
  const t = BigInt('0x' + tweakHex) % N
  if (t === 0n) throw new Error('tweak is zero')
  const mStar = (BigInt('0x' + m.toString(16)) + ((r % N) * t)) % N
  return new BN(mStar.toString(16).padStart(64, '0'), 16)
}

/**
 * `r` as P2 sees it before `step2`: `R = k2 * R1`, where `R1` arrives in
 * message 3. P2's own `step2` recomputes the identical value, so this only
 * reads ahead — it does not change what the protocol verifies.
 */
export function rFromR1(r1Compressed: Uint8Array, k2: BN): bigint {
  const k = BigInt('0x' + k2.toString(16))
  return secp256k1.Point.fromBytes(r1Compressed).multiply(k).toAffine().x % N
}

/** `r` as P1 sees it: it already holds `R` once `step2` has run. */
export function rFromX(x: BN): bigint {
  return BigInt('0x' + x.toString(16)) % N
}
