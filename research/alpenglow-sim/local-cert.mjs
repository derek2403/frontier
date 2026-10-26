// Checks REAL Alpenglow finality certificates from our local Alpenglow node
// (solana-test-validator --alpenglow, Agave 4.3.2) against the validator set
// read from that node. Reads footers from the node's Yellowstone gRPC.
//
// Usage: node local-cert.mjs [seconds]
// Exports helpers for other scripts: readValidatorSet, collectFooterCerts, certPayload.

import { bls12_381 as bls } from '@noble/curves/bls12-381.js'
import grpc from '@grpc/grpc-js'
import loader from '@grpc/proto-loader'

export const RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8899'
export const GRPC = process.env.LOCAL_GRPC || '127.0.0.1:10000'
const PROTO_DIR = new URL('./proto/', import.meta.url).pathname
const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_'

export const rpc = async (method, params = []) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
  return j.result
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export const b58 = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c)); const o = []; while (n > 0n) { o.unshift(Number(n & 255n)); n >>= 8n } for (const c of s) { if (c === '1') o.unshift(0); else break } return Uint8Array.from(o) }
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }

/** Validators in Agave's rank order: stake descending, then compressed BLS key ascending. */
export async function readValidatorSet() {
  const va = await rpc('getVoteAccounts')
  const all = [...va.current, ...va.delinquent].filter((v) => v.activatedStake > 0)
  const infos = await rpc('getMultipleAccounts', [all.map((v) => v.votePubkey), { encoding: 'jsonParsed' }])
  const vals = all
    .map((v, i) => ({ v, k: infos.value[i]?.data?.parsed?.info?.blsPubkeyCompressed }))
    .filter((x) => x.k)
    .map(({ v, k }) => ({ vote: v.votePubkey, stake: BigInt(v.activatedStake), compressed: b58(k), pk: bls.G1.Point.fromBytes(b58(k)) }))
    .sort((a, b) => (a.stake === b.stake ? cmp(a.compressed, b.compressed) : a.stake > b.stake ? -1 : 1))
  const shredVersion = (await rpc('getClusterNodes')).map((n) => n.shredVersion).find((x) => x != null)
  return { vals, shredVersion }
}

/** tag | slot u64 LE | block_id (notarize only) | shred_version u16 LE */
export function certPayload(tag, slot, blockId, shredVersion) {
  const out = new Uint8Array(blockId ? 43 : 11)
  const dv = new DataView(out.buffer)
  out[0] = tag
  dv.setBigUint64(1, BigInt(slot), true)
  if (blockId) out.set(blockId, 9)
  dv.setUint16(blockId ? 41 : 9, shredVersion, true)
  return out
}

export function decodeBitmap(bm) {
  if (bm[0] !== 0) throw new Error(`bitmap version ${bm[0]} not supported`)
  const n = bm[1] | (bm[2] << 8)
  const ranks = []
  for (let i = 0; i < n; i++) if (bm[3 + (i >> 3)] & (1 << (i & 7))) ranks.push(i)
  return { n, ranks }
}

/** Checks one aggregate: returns signed stake share, throws if invalid. */
export function verifyAggregate(agg, payload, vals) {
  const { n, ranks } = decodeBitmap(agg.signer_bitmap)
  if (n !== vals.length) throw new Error(`bitmap has ${n} validators, set has ${vals.length}`)
  const apk = ranks.reduce((a, r) => a.add(vals[r].pk), bls.G1.Point.ZERO)
  const S = bls.G2.Point.fromBytes(agg.signature)
  const H = bls.G2.hashToCurve(payload, { DST })
  if (!bls.fields.Fp12.eql(bls.pairing(apk, H), bls.pairing(bls.G1.Point.BASE, S))) throw new Error('bad signature')
  const total = vals.reduce((a, v) => a + v.stake, 0n)
  const signed = ranks.reduce((a, r) => a + vals[r].stake, 0n)
  return Number((signed * 10000n) / total) / 100
}

/** Streams footers for `ms` and returns finality certificates keyed by slot. */
export function collectFooterCerts(ms, onCert) {
  const def = loader.loadSync('geyser.proto', { includeDirs: [PROTO_DIR], keepCase: true, longs: String, defaults: false, oneofs: true })
  const geyser = grpc.loadPackageDefinition(def).geyser
  const client = new geyser.Geyser(GRPC, grpc.credentials.createInsecure())
  const call = client.Subscribe(new grpc.Metadata())
  const certs = new Map()
  return new Promise((resolve, reject) => {
    call.on('data', (u) => {
      const c = u.block_footer?.block_final_cert
      if (!c) return
      certs.set(Number(c.slot), c)
      onCert?.(c)
    })
    call.on('error', (e) => { if (e.code !== 1) reject(e) })
    call.write({ slots: {}, accounts: {}, transactions: {}, transactions_status: {}, blocks: {}, blocks_meta: {}, entry: {}, accounts_data_slice: [], block_footer: { f: { include_certificates: true } }, commitment: 0 })
    setTimeout(() => { call.cancel(); client.close(); resolve(certs) }, ms)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secs = Number(process.argv[2] ?? 5)
  const { vals, shredVersion } = await readValidatorSet()
  console.log(`local Alpenglow node: ${vals.length} validator(s), shred version ${shredVersion}`)
  const certs = await collectFooterCerts(secs * 1000)
  let ok = 0
  for (const [slot, c] of certs) {
    const fast = !c.notar_aggregate
    const pct = fast
      ? verifyAggregate(c.final_aggregate, certPayload(1, slot, c.final_aggregate.block_id, shredVersion), vals)
      : Math.min(
          verifyAggregate(c.final_aggregate, certPayload(2, slot, null, shredVersion), vals),
          verifyAggregate(c.notar_aggregate, certPayload(1, slot, c.notar_aggregate.block_id, shredVersion), vals),
        )
    ok++
    if (ok <= 3) console.log(`slot ${slot}: ${fast ? 'fast' : 'slow'} finality, block_id ${Buffer.from((c.notar_aggregate ?? c.final_aggregate).block_id).toString('hex').slice(0, 16)}…, ${pct}% stake signed, signature VALID`)
  }
  console.log(`${ok} of ${certs.size} certificates verified`)
}
