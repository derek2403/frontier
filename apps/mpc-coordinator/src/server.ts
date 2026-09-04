/**
 * SODA MPC coordinator.
 *
 * Stateless HTTP service that, given a payload hash and an optional SODA
 * tweak, drives the 4-message Lindell '17 protocol between two `mpc-node`
 * peers and returns the resulting ECDSA signature.
 *
 *   POST /sign { payloadHex, tweakHex? } → { r, s, v }
 *
 * The coordinator never sees a secret share. It only forwards opaque
 * protocol messages between P1 and P2. Compromise of the coordinator =
 * denial of service, not key theft.
 *
 * Wired into the SODA flow:
 *   1. caller program emits SigRequested via soda::request_signature
 *   2. an out-of-band watcher (the existing apps/relayer or a thin Solana
 *      listener) reads payload + tweak from the SigRequest PDA
 *   3. POST /sign here, get (r, s, v) back
 *   4. submit soda::finalize_signature(sig, recovery_id) on Solana
 *
 * This release is the cryptographic core only. Step 2 + 4 stay in the
 * existing Rust signer / relayer until v0.6.
 */

import Fastify from 'fastify'
import { Agent, request } from 'undici'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'

// Trailing slashes turn `/sign` into `//sign`, which Fastify treats as a
// different route and 404s. Operators paste URLs with slashes; strip them.
const stripSlash = (u: string) => u.replace(/\/+$/, '')

const NODE_P1_URL = stripSlash(process.env.MPC_NODE_P1_URL ?? 'http://localhost:8001')
const NODE_P2_URL = stripSlash(process.env.MPC_NODE_P2_URL ?? 'http://localhost:8002')
const PORT = Number(process.env.PORT ?? 8000)

// Bearer token this coordinator presents to the two nodes. Must equal the
// MPC_AUTH_TOKEN set on both of them.
const NODE_AUTH_TOKEN = process.env.MPC_NODE_AUTH_TOKEN ?? ''

// Bearer token callers must present to this coordinator. The coordinator can
// sign any payload the committee will sign, so on a public host this is the
// only thing between the internet and the committee. Unset = open.
const AUTH_TOKEN = process.env.MPC_AUTH_TOKEN ?? ''

// Connect / response timeouts. Localhost is fast; tunneled / cross-region
// peers can cold-start. Bump from undici defaults (10s connect, 30s headers)
// so the first-after-idle request doesn't fail before the peer answers.
// Render free instances sleep after 15 idle minutes and take about a minute
// to wake, so the default has to clear two cold starts.
const PEER_HTTP_TIMEOUT_MS = Number(process.env.MPC_PEER_TIMEOUT_MS ?? 150_000)
const peerAgent = new Agent({
  connect: { timeout: PEER_HTTP_TIMEOUT_MS },
  bodyTimeout: PEER_HTTP_TIMEOUT_MS,
  headersTimeout: PEER_HTTP_TIMEOUT_MS,
})

// The platform's own health check calls GET /health. It must answer quickly
// even when a peer is asleep or gone, or the deploy is marked unhealthy for
// a problem that is not the coordinator's. This needs a separate Agent: the
// connect timeout is what actually bounds an unreachable peer, and an
// AbortSignal does not interrupt undici's TCP connect phase.
const HEALTH_PEER_TIMEOUT_MS = Number(process.env.MPC_HEALTH_TIMEOUT_MS ?? 5_000)
const healthAgent = new Agent({
  connect: { timeout: HEALTH_PEER_TIMEOUT_MS },
  bodyTimeout: HEALTH_PEER_TIMEOUT_MS,
  headersTimeout: HEALTH_PEER_TIMEOUT_MS,
})

// The 4-message protocol touches P1, P2, P1, P2, P1 in strict order. If both
// peers are asleep, that wakes them one after the other. A parallel GET
// /health first overlaps the two cold starts instead. Costs one round trip
// when the peers are already awake. Set MPC_PREWARM_PEERS=0 to skip it.
const PREWARM_PEERS = process.env.MPC_PREWARM_PEERS !== '0'

const app = Fastify({ logger: { level: 'info' } })

app.addHook('onRequest', async (req, reply) => {
  if (!AUTH_TOKEN) return
  // /health stays open: it is how you pre-warm the stack before a demo, and
  // it reveals only the group public key, which is already on-chain.
  if (req.url.split('?')[0] === '/health') return
  if (!bearerMatches(req.headers.authorization)) {
    app.log.warn({ url: req.url, ip: req.ip }, 'rejected unauthenticated request')
    return reply.code(401).send({ error: 'unauthorized' })
  }
})

app.get('/health', async () => {
  const [p1, p2] = await Promise.all([
    fetchJson(`${NODE_P1_URL}/health`, healthAgent).catch((e) => ({
      error: String(e),
    })),
    fetchJson(`${NODE_P2_URL}/health`, healthAgent).catch((e) => ({
      error: String(e),
    })),
  ])
  return { ok: true, peers: { p1, p2 } }
})

app.post<{
  Body: { payloadHex: string; tweakHex?: string }
}>('/sign', async (req, reply) => {
  const { payloadHex, tweakHex } = req.body
  if (!/^[0-9a-fA-F]{64}$/.test(payloadHex)) {
    return reply.code(400).send({ error: 'payloadHex must be 32 bytes hex' })
  }
  if (tweakHex && !/^[0-9a-fA-F]{64}$/.test(tweakHex)) {
    return reply.code(400).send({ error: 'tweakHex must be 32 bytes hex' })
  }

  const sessionId = randomUUID()
  app.log.info({ sessionId, hasTweak: !!tweakHex }, 'starting signing session')

  if (PREWARM_PEERS) {
    await Promise.all([
      fetchJson(`${NODE_P1_URL}/health`).catch(() => null),
      fetchJson(`${NODE_P2_URL}/health`).catch(() => null),
    ])
  }

  // Step 1: P1 starts → message1 outbound to P2.
  const init = await postJson(`${NODE_P1_URL}/sign/init`, {
    sessionId,
    payloadHex,
    tweakHex,
  })
  let message: string = init.messageBase64

  // Step 2: P2 receives msg1, returns msg2.
  const r2 = await postJson(`${NODE_P2_URL}/sign/step`, {
    sessionId,
    messageBase64: message,
    payloadHex,
    tweakHex,
  })
  message = r2.messageBase64

  // Step 3: P1 receives msg2, returns msg3.
  const r3 = await postJson(`${NODE_P1_URL}/sign/step`, {
    sessionId,
    messageBase64: message,
  })
  message = r3.messageBase64

  // Step 4: P2 receives msg3, returns msg4.
  const r4 = await postJson(`${NODE_P2_URL}/sign/step`, {
    sessionId,
    messageBase64: message,
  })
  message = r4.messageBase64

  // Step 5: P1 receives msg4, finalizes, exports sig.
  const final = await postJson(`${NODE_P1_URL}/sign/step`, {
    sessionId,
    messageBase64: message,
  })

  if (!final.sig) {
    return reply
      .code(500)
      .send({ error: 'P1 did not return final signature', got: final })
  }

  // Normalize to low-s and adjust v accordingly. The on-chain
  // secp256k1_recover syscall accepts both, but most ETH RPCs reject high-s.
  const { r, s, v } = normalizeLowS(final.sig)

  // Sanity: verify the signature against the joint public key (no tweak)
  // or the tweaked key. We only have group_pk on the node /health response,
  // so do the verify there if needed; here we just return.
  app.log.info({ sessionId, v }, 'signing session complete')
  return { r, s, v }
})

await app.listen({ host: '0.0.0.0', port: PORT })
app.log.info(
  { port: PORT, p1: NODE_P1_URL, p2: NODE_P2_URL, authenticated: !!AUTH_TOKEN },
  'mpc-coordinator ready',
)
if (!AUTH_TOKEN) {
  app.log.warn(
    'MPC_AUTH_TOKEN is not set — /sign is open to any caller. ' +
      'Set it on any host that has a public address.',
  )
}

/** Auth header the coordinator presents to the nodes, if a token is set. */
function peerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return NODE_AUTH_TOKEN
    ? { ...extra, authorization: `Bearer ${NODE_AUTH_TOKEN}` }
    : extra
}

/** Constant-time compare of an inbound `Authorization: Bearer <token>`. */
function bearerMatches(header: string | undefined): boolean {
  if (!header) return false
  const want = Buffer.from(`Bearer ${AUTH_TOKEN}`)
  const got = Buffer.from(header)
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

/**
 * GET a peer. The caller picks the agent, and so the timeout: `healthAgent`
 * fails fast for the health check, `peerAgent` waits out a sleeping
 * instance's cold start for the pre-warm.
 */
async function fetchJson(url: string, dispatcher: Agent = peerAgent): Promise<any> {
  const res = await request(url, {
    method: 'GET',
    headers: peerHeaders(),
    dispatcher,
  })
  return res.body.json()
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await request(url, {
    method: 'POST',
    headers: peerHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    dispatcher: peerAgent,
  })
  if (res.statusCode >= 400) {
    const text = await res.body.text()
    throw new Error(`POST ${url} failed: ${res.statusCode} ${text}`)
  }
  return res.body.json()
}

/**
 * ECDSA signatures are malleable: (r, s) and (r, n-s) are both valid for
 * the same message. Some verifiers (Ethereum's `ecrecover`, libsecp256k1
 * `--with-malleable=no`) reject high-s. Normalize and flip the recovery
 * bit if we did.
 */
function normalizeLowS(sig: { r: string; s: string; v: number }): {
  r: string
  s: string
  v: number
} {
  const N = secp256k1.Point.Fn.ORDER
  const sBig = BigInt('0x' + sig.s)
  if (sBig <= N / 2n) return sig
  const sLow = N - sBig
  const sHex = sLow.toString(16).padStart(64, '0')
  return { r: sig.r, s: sHex, v: sig.v ^ 1 }
}
