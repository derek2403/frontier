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
import { timingSafeEqual } from 'node:crypto'
import { loadShare, type Role } from './share.js'
import { setSession, getSession, dropSession } from './sessions.js'
import { authorize, AUTHORIZATION_ENABLED } from './authorize.js'

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

/**
 * Shared secret between the coordinator and this node.
 *
 * On AWS the nodes were protected by security groups: only the coordinator's
 * private IP could reach port 8001 / 8002. Platforms that give every service
 * a public URL (Render's free tier, Fly, Railway) have no such filter, so the
 * node must authenticate the caller itself. Without this, anyone who finds
 * the URL can run the protocol and get a valid committee signature on any
 * payload they choose.
 *
 * Unset = open. That keeps `docker compose -f docker-compose.mpc.yml up` and
 * local `pnpm dev` working with no configuration. The startup log says so.
 */
const AUTH_TOKEN = process.env.MPC_AUTH_TOKEN ?? ''

const app = Fastify({ logger: { level: 'info' } })

app.addHook('onRequest', async (req, reply) => {
  if (!AUTH_TOKEN) return
  // Render polls the health check without credentials, and the response only
  // contains the group public key, which is already on-chain.
  if (req.url.split('?')[0] === '/health') return
  if (!bearerMatches(req.headers.authorization)) {
    app.log.warn({ url: req.url, ip: req.ip }, 'rejected unauthenticated request')
    return reply.code(401).send({ error: 'unauthorized' })
  }
})

app.get('/health', async () => ({
  ok: true,
  role: ROLE,
  groupPkXY: share.groupPkXY,
}))

/**
 * P1 starts a session. Returns the first outgoing message; coordinator
 * forwards it to P2.
 *
 * The caller supplies ONLY a SigRequest account address. This node reads that
 * account from its own Solana RPC and derives the payload and tweak from what
 * the chain says — so it can only ever sign something a confirmed on-chain
 * request already committed to. There is deliberately no raw-payload path.
 */
app.post<{
  Body: { sessionId: string; sigRequestPubkey: string }
}>('/sign/init', async (req, reply) => {
  if (ROLE !== 'p1') {
    return reply.code(400).send({ error: 'only P1 starts a session' })
  }
  const { sessionId, sigRequestPubkey } = req.body
  if (typeof sigRequestPubkey !== 'string' || !sigRequestPubkey) {
    return reply.code(400).send({ error: 'sigRequestPubkey is required' })
  }

  let authorized
  try {
    authorized = await authorize(sigRequestPubkey, compressedGroupPk())
  } catch (err) {
    app.log.warn(
      { sigRequestPubkey, reason: (err as Error).message },
      'refused to sign: request failed on-chain authorization',
    )
    return reply.code(403).send({ error: (err as Error).message })
  }

  const m = new BN(authorized.payloadHex, 16)
  // NOTE: applyTweakP1 was removed — it was a verified no-op. Safeheron shares
  // the key multiplicatively (Q = x1*x2*G) and P2 holds a Paillier ciphertext
  // of x1 fixed at DKG, so mutating P1's local x1 cannot change the output.
  // The real fix is additive, applied on P2's side of message 4; until it
  // lands, signatures recover to plain group_pk and finalize_signature will
  // reject them. Authorization is still enforced above.
  const shareJson = share.share

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
  Body: { sessionId: string; messageBase64: string; sigRequestPubkey?: string }
}>('/sign/step', async (req, reply) => {
  const { sessionId, messageBase64, sigRequestPubkey } = req.body
  let ctx = getSession(sessionId)

  // P2's first call also bootstraps: it needs the payload to set up context.
  // It re-authorizes independently rather than trusting P1 or the coordinator
  // — that independence is the point of the check.
  if (!ctx) {
    if (ROLE !== 'p2') {
      return reply.code(404).send({ error: 'no such session' })
    }
    if (!sigRequestPubkey) {
      return reply
        .code(400)
        .send({ error: 'P2 first call needs sigRequestPubkey' })
    }

    let authorized
    try {
      authorized = await authorize(sigRequestPubkey, compressedGroupPk())
    } catch (err) {
      app.log.warn(
        { sigRequestPubkey, reason: (err as Error).message },
        'refused to sign: request failed on-chain authorization',
      )
      return reply.code(403).send({ error: (err as Error).message })
    }

    const m = new BN(authorized.payloadHex, 16)
    ctx = await TPCEcdsaSign.P2Context.createContext(
      JSON.stringify(share.share),
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

// Default to all interfaces, because the coordinator normally reaches this
// node from another host. The all-in-one supervisor overrides it to
// 127.0.0.1, so the nodes are invisible to the platform's port scanner and
// only the coordinator's port can ever be routed.
const BIND_HOST = process.env.MPC_BIND_HOST ?? '0.0.0.0'

await app.listen({ host: BIND_HOST, port: PORT })
app.log.info(
  {
    role: ROLE,
    port: PORT,
    authenticated: !!AUTH_TOKEN,
    onChainAuthorization: AUTHORIZATION_ENABLED,
  },
  'mpc-node ready',
)
if (!AUTH_TOKEN) {
  app.log.warn(
    'MPC_AUTH_TOKEN is not set — /sign is open to any caller. ' +
      'Set it on any host that has a public address.',
  )
}
if (!AUTHORIZATION_ENABLED) {
  app.log.error(
    'SODA_PROGRAM_ID is not set — on-chain authorization is DISABLED and ' +
      '/sign/* will refuse every request. Set SODA_PROGRAM_ID and ' +
      'SODA_KNOWN_REQUESTERS so this node can verify requests against Solana.',
  )
}

/**
 * Constant-time compare of an `Authorization: Bearer <token>` header against
 * the configured token. `timingSafeEqual` throws on a length mismatch, so
 * compare lengths first and accept the leak of the token's length.
 */
function bearerMatches(header: string | undefined): boolean {
  if (!header) return false
  const want = Buffer.from(`Bearer ${AUTH_TOKEN}`)
  const got = Buffer.from(header)
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

/**
 * The committee's group public key in 33-byte compressed form, rebuilt from
 * the X||Y stored alongside the share. Authorization needs it to re-derive
 * `group_pk + tweak*G` and compare against what the chain stored.
 */
function compressedGroupPk(): Uint8Array {
  const x = Buffer.from(share.groupPkXY.x.padStart(64, '0'), 'hex')
  const y = Buffer.from(share.groupPkXY.y.padStart(64, '0'), 'hex')
  const prefix = (y[y.length - 1] & 1) === 0 ? 0x02 : 0x03
  return Uint8Array.from(Buffer.concat([Buffer.from([prefix]), x]))
}
