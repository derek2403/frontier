/**
 * The test that the old `applyTweakP1` never had.
 *
 * It runs a real DKG and a real Lindell '17 signing session in-process, with
 * the tweak applied exactly where `server.ts` applies it, and then performs
 * the same check `soda::finalize_signature` performs on-chain:
 * `secp256k1_recover(payload, sig, v)` must equal the stored `foreign_pk_xy`.
 *
 * The previous bug returned HTTP 200 with a signature that recovered to plain
 * `group_pk`, so "it signed" was never evidence of anything. This asserts the
 * recovered key, which is the only thing that matters.
 */
import { describe, expect, it } from 'vitest'
import pkg from '@safeheron/two-party-ecdsa-js'
import BN from 'bn.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'

import { tweakedMessage, rFromR1, rFromX } from './tweak.js'

const { TPCEcdsaKeyGen, TPCEcdsaSign } = pkg
const N = secp256k1.Point.Fn.ORDER

type Ctx1 = InstanceType<typeof TPCEcdsaSign.P1Context> & { m: BN; R: any }
type Ctx2 = InstanceType<typeof TPCEcdsaSign.P2Context> & { m: BN; k2: BN }

async function dkg() {
  const p1 = await TPCEcdsaKeyGen.P1Context.createContext()
  const p2 = await TPCEcdsaKeyGen.P2Context.createContext()
  p2.step2(p1.step2(p2.step1(p1.step1())))
  return {
    share1: JSON.stringify(p1.exportKeyShare().toJsonObject()),
    share2: JSON.stringify(p2.exportKeyShare().toJsonObject()),
    groupPk: Uint8Array.from(p1.exportKeyShare().Q.encodeCompressed('array')),
  }
}

/** Drives the 4 messages the way the coordinator does, tweak and all. */
async function sign(
  share1: string,
  share2: string,
  payload: Uint8Array,
  tweakHex: string | null,
) {
  const m = new BN(Buffer.from(payload).toString('hex'), 16)
  const c1 = (await TPCEcdsaSign.P1Context.createContext(share1, m)) as Ctx1
  const c2 = (await TPCEcdsaSign.P2Context.createContext(share2, m)) as Ctx2

  const msg3 = c1.step2(c2.step1(c1.step1()))

  if (tweakHex) {
    const r1 = TPCEcdsaSign.Message3.fromProtobuf(msg3).proof_R1.pk
    c2.m = tweakedMessage(
      c2.m,
      rFromR1(Uint8Array.from(r1.encodeCompressed('array')), c2.k2),
      tweakHex,
    )
  }
  const msg4 = c2.step2(msg3)

  if (tweakHex) {
    c1.m = tweakedMessage(c1.m, rFromX(c1.R.getX()), tweakHex)
  }
  c1.step3(msg4)

  const [r, s, v] = c1.exportSig()
  return {
    compact: Buffer.concat([
      r.toArrayLike(Buffer, 'be', 32),
      s.toArrayLike(Buffer, 'be', 32),
    ]),
    v,
  }
}

/** Exactly what `finalize_signature` does with the secp256k1_recover syscall. */
function recover(payload: Uint8Array, compact: Buffer, v: number): Uint8Array {
  return secp256k1.Signature.fromBytes(compact, 'compact')
    .addRecoveryBit(v & 1)
    .recoverPublicKey(payload)
    .toBytes(true)
}

const foreignPk = (groupPk: Uint8Array, tweakHex: string): Uint8Array =>
  secp256k1.Point.fromBytes(groupPk)
    .add(secp256k1.Point.BASE.multiply(BigInt('0x' + tweakHex) % N))
    .toBytes(true)

describe('signing for a SODA-derived address', () => {
  const payload = Uint8Array.from(Buffer.alloc(32, 0x42))
  const tweakHex =
    'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

  it('recovers to group_pk + tweak*G, not to group_pk', async () => {
    const { share1, share2, groupPk } = await dkg()
    const { compact, v } = await sign(share1, share2, payload, tweakHex)

    const recovered = recover(payload, compact, v)
    expect(Buffer.from(recovered).toString('hex')).toBe(
      Buffer.from(foreignPk(groupPk, tweakHex)).toString('hex'),
    )
    // The precise shape of the old bug, pinned so it cannot come back.
    expect(Buffer.from(recovered).equals(Buffer.from(groupPk))).toBe(false)
  }, 120_000)

  it('produces a signature the foreign chain verifies', async () => {
    const { share1, share2, groupPk } = await dkg()
    const { compact } = await sign(share1, share2, payload, tweakHex)
    expect(
      secp256k1.verify(compact, payload, foreignPk(groupPk, tweakHex), {
        prehash: false,
      }),
    ).toBe(true)
  }, 120_000)

  it('still signs for group_pk itself when there is no tweak', async () => {
    const { share1, share2, groupPk } = await dkg()
    const { compact, v } = await sign(share1, share2, payload, null)
    expect(Buffer.from(recover(payload, compact, v)).toString('hex')).toBe(
      Buffer.from(groupPk).toString('hex'),
    )
  }, 120_000)

  it('gives a different address per tweak', async () => {
    const { share1, share2, groupPk } = await dkg()
    const other =
      '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
    const { compact, v } = await sign(share1, share2, payload, other)
    const recovered = recover(payload, compact, v)
    expect(Buffer.from(recovered).toString('hex')).toBe(
      Buffer.from(foreignPk(groupPk, other)).toString('hex'),
    )
    expect(Buffer.from(recovered).toString('hex')).not.toBe(
      Buffer.from(foreignPk(groupPk, tweakHex)).toString('hex'),
    )
  }, 120_000)
})

describe('tweakedMessage', () => {
  it('is m + r*t mod n', () => {
    const m = new BN('05', 16)
    const out = tweakedMessage(m, 3n, '07')
    expect(out.toString(10)).toBe('26') // 5 + 3*7
  })

  it('refuses a zero tweak', () => {
    expect(() => tweakedMessage(new BN('05', 16), 3n, '00')).toThrow(/zero/)
  })
})
