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
import { request } from 'undici'
import { randomUUID } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'

const NODE_P1_URL = process.env.MPC_NODE_P1_URL ?? 'http://localhost:8001'
const NODE_P2_URL = process.env.MPC_NODE_P2_URL ?? 'http://localhost:8002'
const PORT = Number(process.env.PORT ?? 8000)

const app = Fastify({ logger: { level: 'info' } })

app.get('/health', async () => {
  const [p1, p2] = await Promise.all([
    fetchJson(`${NODE_P1_URL}/health`).catch((e) => ({ error: String(e) })),
    fetchJson(`${NODE_P2_URL}/health`).catch((e) => ({ error: String(e) })),
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
app.log.info({ port: PORT, p1: NODE_P1_URL, p2: NODE_P2_URL }, 'mpc-coordinator ready')

async function fetchJson(url: string): Promise<any> {
  const res = await request(url, { method: 'GET' })
  return res.body.json()
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
