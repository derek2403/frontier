/**
 * MPC signer node — Lindell '17 2-of-2 ECDSA, role=p1 or role=p2.
 *
 * Two of these run side-by-side. The coordinator drives the 4-message
 * signing protocol by POSTing each peer's outgoing message to the other's
 * /sign/step endpoint. Neither node ever sees the other's secret share, so
 * compromise of one host does not yield the group secret.
 *
 * Endpoints:
 *   GET  /health            → { ok: true, role, groupPkXY }
 *   POST /sign/init         → starts a session keyed by `sessionId`,
 *                             returns the first outgoing protocol message
 *                             (P1 only — P2 waits for the first inbound).
 *   POST /sign/step         → feeds an incoming message and returns the
 *                             outgoing one. Final P1 step returns
 *                             { sig: { r, s, v } }.
 */

import Fastify from 'fastify'
import pkg from '@safeheron/two-party-ecdsa-js'
import BN from 'bn.js'
import { loadShare, type Role } from './share.js'
import { setSession, getSession, dropSession } from './sessions.js'

const { TPCEcdsaSign } = pkg

const ROLE = (process.env.MPC_ROLE ?? 'p1') as Role
if (ROLE !== 'p1' && ROLE !== 'p2') {
  throw new Error(`MPC_ROLE must be 'p1' or 'p2', got: ${ROLE}`)
}

const SHARE_PATH = process.env.MPC_SHARE_PATH ?? `/data/share-${ROLE}.json`
const PORT = Number(process.env.PORT ?? (ROLE === 'p1' ? 8001 : 8002))

const share = loadShare(SHARE_PATH)
if (share.role !== ROLE) {
  throw new Error(
    `Share role mismatch: expected ${ROLE}, share file says ${share.role}`,
  )
}

const app = Fastify({ logger: { level: 'info' } })

app.get('/health', async () => ({
  ok: true,
  role: ROLE,
  groupPkXY: share.groupPkXY,
}))

/**
 * P1 starts a session. Returns the first outgoing message; coordinator
 * forwards it to P2.
 *
 * The optional `tweakHex` is the SODA derivation tweak: P1 adds it to its
 * share before signing, so the resulting signature recovers to
 * `group_pk + tweak * G` (the SODA-derived foreign address).
 */
app.post<{
  Body: { sessionId: string; payloadHex: string; tweakHex?: string }
}>('/sign/init', async (req, reply) => {
  if (ROLE !== 'p1') {
    return reply.code(400).send({ error: 'only P1 starts a session' })
  }
  const { sessionId, payloadHex, tweakHex } = req.body
  if (!/^[0-9a-fA-F]{64}$/.test(payloadHex)) {
    return reply.code(400).send({ error: 'payloadHex must be 32 bytes hex' })
  }

  const m = new BN(payloadHex, 16)
  let shareJson = share.share
  if (tweakHex) {
    if (!/^[0-9a-fA-F]{64}$/.test(tweakHex)) {
      return reply.code(400).send({ error: 'tweakHex must be 32 bytes hex' })
    }
    shareJson = applyTweakP1(share.share, tweakHex)
  }

  const ctx = await TPCEcdsaSign.P1Context.createContext(
    JSON.stringify(shareJson),
    m,
  )
  setSession(sessionId, ctx)
  const message1 = ctx.step1()
  return { messageBase64: Buffer.from(message1).toString('base64') }
})

/**
 * P2 receives the first message and starts its own session. Then either P1
 * or P2 calls /sign/step with subsequent messages; the role determines what
 * step number we're at via the lib's internal expectedStep.
 */
app.post<{
  Body: { sessionId: string; messageBase64: string; payloadHex?: string; tweakHex?: string }
}>('/sign/step', async (req, reply) => {
  const { sessionId, messageBase64, payloadHex, tweakHex } = req.body
  let ctx = getSession(sessionId)

  // P2's first call also bootstraps: it needs the payload to set up context.
  if (!ctx) {
    if (ROLE !== 'p2') {
      return reply.code(404).send({ error: 'no such session' })
    }
    if (!payloadHex || !/^[0-9a-fA-F]{64}$/.test(payloadHex)) {
      return reply
        .code(400)
        .send({ error: 'P2 first call needs payloadHex (32 bytes)' })
    }
    let shareJson = share.share
    if (tweakHex) {
      if (!/^[0-9a-fA-F]{64}$/.test(tweakHex)) {
        return reply.code(400).send({ error: 'tweakHex must be 32 bytes hex' })
      }
      // Tweak is applied entirely to P1's share; P2 leaves its share alone.
      // (The math: x1' = x1 + tweak, x2' = x2 → x1'+x2' = group_sk + tweak.)
    }
    const m = new BN(payloadHex, 16)
    ctx = await TPCEcdsaSign.P2Context.createContext(
      JSON.stringify(shareJson),
      m,
    )
    setSession(sessionId, ctx)
  }

  const incoming = Buffer.from(messageBase64, 'base64')

  // Dispatch on which class of context this is. The lib's step methods are
  // identically named (step1, step2, step3) but have different signatures.
  if (ROLE === 'p1') {
    const c = ctx as InstanceType<typeof TPCEcdsaSign.P1Context>
    // P1 is called twice after init: step2 (with msg2 from P2), step3 (with msg4 from P2).
    // The lib tracks `expectedStep`; here we read it via try/catch sequencing.
    if (typeof (c as any).expectedStep !== 'number') {
      return reply.code(500).send({ error: 'session lost expectedStep' })
    }
    const expectedStep = (c as any).expectedStep
    if (expectedStep === 2) {
      const out = c.step2(incoming)
      return { messageBase64: Buffer.from(out).toString('base64') }
    } else if (expectedStep === 3) {
      c.step3(incoming)
      const [r, s, v] = c.exportSig()
      dropSession(sessionId)
      return {
        sig: {
          r: r.toArrayLike(Buffer, 'be', 32).toString('hex'),
          s: s.toArrayLike(Buffer, 'be', 32).toString('hex'),
          v,
        },
      }
    } else {
      return reply
        .code(400)
        .send({ error: `P1 in unexpected step ${expectedStep}` })
    }
  } else {
    const c = ctx as InstanceType<typeof TPCEcdsaSign.P2Context>
    const expectedStep = (c as any).expectedStep ?? 1
    if (expectedStep === 1) {
      const out = c.step1(incoming)
      return { messageBase64: Buffer.from(out).toString('base64') }
    } else if (expectedStep === 2) {
      const out = c.step2(incoming)
      return { messageBase64: Buffer.from(out).toString('base64') }
    } else {
      return reply
        .code(400)
        .send({ error: `P2 in unexpected step ${expectedStep}` })
    }
  }
})

await app.listen({ host: '0.0.0.0', port: PORT })
app.log.info({ role: ROLE, port: PORT }, 'mpc-node ready')

/**
 * Apply SODA tweak to P1's share so the resulting signature recovers to
 * `group_pk + tweak * G` instead of `group_pk`. We add the tweak to x1
 * (mod n). x2 is unchanged because additive shares are linear in the secret.
 */
function applyTweakP1(shareJson: object, tweakHex: string): object {
  const obj = JSON.parse(JSON.stringify(shareJson)) as {
    x1?: string
    Q?: { x?: string; y?: string }
  }
  const N = new BN(
    'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
    16,
  )
  const x1 = new BN(obj.x1 ?? '', 16)
  const tweak = new BN(tweakHex, 16)
  const x1Tweaked = x1.add(tweak).umod(N)
  obj.x1 = x1Tweaked.toString(16)
  // Q (group public point) is also tweaked; the coordinator passes the
  // already-derived `foreign_pk` into the on-chain SigRequest, so we do
  // NOT update Q on the share — the lib uses x1 to compute the partial sig
  // and recovers consistently with the externally-tweaked Q.
  return obj
}
