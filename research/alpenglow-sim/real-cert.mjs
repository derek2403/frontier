// Verifies a REAL Alpenglow certificate from Solana devnet with the real
// validators' BLS keys, off-chain. No simulated keys.
//
// Sources (Agave main, read 22 Oct 2026):
//   signed bytes   votor-messages/src/wire.rs   VotePayloadToSign (wincode):
//                  tag u8 | slot u64 LE | block_id [32] (block votes only) | shred_version u16 LE
//   tags           Notar=1 Finalize=2 Skip=3 NotarFallback=4 SkipFallback=5 Genesis=6
//   BLS            solana-bls-signatures 4.0.1: sig in G2, key in G1,
//                  DST "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_"
//   bitmap         solana-signer-store 0.1.0: version u8 | bit count u16 LE | bits (Lsb0)
//   rank order     runtime/src/epoch_stakes.rs: stake descending, then compressed BLS key ascending
//
// Usage: node real-cert.mjs

import fs from 'node:fs'
import { bls12_381 as bls } from '@noble/curves/bls12-381.js'

const RPC = process.env.RPC || 'https://api.devnet.solana.com'
const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_'
const rpc = async (method, params = []) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
  return j.result
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58decode(s) {
  let n = 0n
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c))
  const out = []
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n }
  for (const c of s) { if (c === '1') out.unshift(0); else break }
  return Uint8Array.from(out)
}
const hex = (b) => Buffer.from(b).toString('hex')
const cmpBytes = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }

// ---- 1. the real certificate ----
const cert = await rpc('getAgGenesisCert')
const { slot, blockId } = cert.block
const bitmap = Uint8Array.from(cert.signature.bitmap)
const sigBytes = Uint8Array.from(cert.signature.signature)
const version = bitmap[0]
const nBits = bitmap[1] | (bitmap[2] << 8)
const signerRanks = []
for (let i = 0; i < nBits; i++) if (bitmap[3 + (i >> 3)] & (1 << (i & 7))) signerRanks.push(i)
console.log(`certificate: genesis, slot ${slot}, block_id ${hex(blockId)}`)
console.log(`bitmap: version ${version}, ${nBits} ranked validators, ${signerRanks.length} signed: ranks [${signerRanks}]`)

// ---- 2. the signed bytes ----
const nodes = await rpc('getClusterNodes')
const shredVersion = [...new Set(nodes.map((n) => n.shredVersion))][0]
const payload = new Uint8Array(1 + 8 + 32 + 2)
const dv = new DataView(payload.buffer)
payload[0] = 6 // Genesis
dv.setBigUint64(1, BigInt(slot), true)
payload.set(blockId, 9)
dv.setUint16(41, shredVersion, true)
console.log(`shred version ${shredVersion}; signed bytes (${payload.length}): ${hex(payload)}`)

// ---- 3. the real validator set ----
const va = await rpc('getVoteAccounts', [{ keepUnstakedDelinquents: false }])
const all = [...va.current, ...va.delinquent].filter((v) => v.activatedStake > 0)
// getMultipleAccounts takes at most 100 keys per call.
const infos = { value: [] }
for (let i = 0; i < all.length; i += 100) {
  const part = await rpc('getMultipleAccounts', [all.slice(i, i + 100).map((v) => v.votePubkey), { encoding: 'jsonParsed' }])
  infos.value.push(...part.value)
}
const vals = []
all.forEach((v, i) => {
  const k = infos.value[i]?.data?.parsed?.info?.blsPubkeyCompressed
  if (!k) return
  const compressed = b58decode(k)
  vals.push({ vote: v.votePubkey, stake: BigInt(v.activatedStake), compressed, pk: bls.G1.Point.fromBytes(compressed) })
})
vals.sort((a, b) => (a.stake === b.stake ? cmpBytes(a.compressed, b.compressed) : a.stake > b.stake ? -1 : 1))
console.log(`devnet now: ${all.length} staked vote accounts, ${vals.length} with a BLS key`)

// ---- 4. the signature: try both 192-byte G2 layouts ----
function parseSig(b) {
  const tries = []
  try { tries.push(['zcash uncompressed', bls.G2.Point.fromBytes(b)]) } catch {}
  // c0 before c1 (the order EIP-2537 and some libraries use)
  try {
    const n = (o) => BigInt('0x' + hex(b.slice(o, o + 48)))
    const Fp2 = bls.fields.Fp2
    const P = bls.G2.Point.fromAffine({ x: Fp2.create({ c0: n(0), c1: n(48) }), y: Fp2.create({ c0: n(96), c1: n(144) }) })
    P.assertValidity()
    tries.push(['c0-first uncompressed', P])
  } catch {}
  return tries
}
const sigs = parseSig(sigBytes)
console.log(`signature parses as: ${sigs.map((s) => s[0]).join(', ') || 'nothing'}`)
const H = bls.G2.hashToCurve(payload, { DST })

const check = (ranks, set) => {
  const agg = ranks.reduce((acc, r) => acc.add(set[r].pk), bls.G1.Point.ZERO)
  for (const [name, S] of sigs) {
    if (bls.fields.Fp12.eql(bls.pairing(agg, H), bls.pairing(bls.G1.Point.BASE, S))) return name
  }
  return null
}

// a) today's ranking, if devnet still has the same validator count
let signerSet = signerRanks.map((r) => vals[r])
let ok = vals.length >= nBits ? check(signerRanks, vals.slice(0, nBits)) : null
if (ok) {
  const ranked = vals.slice(0, nBits)
  const total = ranked.reduce((a, v) => a + v.stake, 0n)
  const signed = signerRanks.reduce((a, r) => a + ranked[r].stake, 0n)
  console.log(`\nVERIFIED with the official ranking (${ok}).`)
  console.log(`stake: ${signed / 1_000_000_000n} of ${total / 1_000_000_000n} SOL signed = ${(Number((signed * 10000n) / total) / 100).toFixed(2)}%`)
} else {
  // b) stakes moved since the genesis epoch, so the ranking may differ.
  //    The signers are 11 of today's keys; search the subsets cheaply by
  //    pairing once per candidate set. Bounded to small devnet sizes.
  console.log(`today's ranking does not reproduce it; searching signer sets among ${vals.length} keys…`)
  const k = signerRanks.length
  const n = vals.length
  const PS = sigs.map(([name, S]) => [name, bls.pairing(bls.G1.Point.BASE, S)])
  const HPair = (agg) => bls.pairing(agg, H)
  let found = null, tried = 0
  const idx = []
  const rec = (start, acc) => {
    if (found) return
    if (idx.length === k) {
      tried++
      const left = HPair(acc)
      for (const [name, R] of PS) if (bls.fields.Fp12.eql(left, R)) { found = { name, idx: [...idx] }; return }
      return
    }
    for (let i = start; i <= n - (k - idx.length); i++) { idx.push(i); rec(i + 1, acc.add(vals[i].pk)); idx.pop(); if (found) return }
  }
  const total = (() => { let c = 1n; for (let i = 0; i < k; i++) c = (c * BigInt(n - i)) / BigInt(i + 1); return c })()
  console.log(`subsets to try: ${total}`)
  if (total <= 200000n) rec(0, bls.G1.Point.ZERO)
  if (found) {
    console.log(`\nVERIFIED (${found.name}) after ${tried} tries. Signers today:`)
    for (const i of found.idx) console.log(`  ${vals[i].vote}  stake ${(Number(vals[i].stake) / 1e9).toFixed(0)} SOL`)
    ok = found.name
    signerSet = found.idx.map((i) => vals[i])
  } else console.log('\nNOT verified')
}
if (ok) console.log(`\nsigned stake check: ${signerRanks.length} of ${nBits} ranked validators signed (genesis threshold applies)`)

if (ok) {
  // EIP-2537 encodings for the on-chain check: Fp elements as 64-byte big endian, c0 before c1.
  const fp = (x) => x.toString(16).padStart(128, '0')
  const S = bls.G2.Point.fromBytes(sigBytes).toAffine()
  fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true })
  fs.writeFileSync(new URL(process.env.OUT || './out/real-cert.json', import.meta.url), JSON.stringify({
    slot, blockId: '0x' + hex(blockId), shredVersion, tag: 6, payload: '0x' + hex(payload),
    signers: signerSet.map((v) => { const a = v.pk.toAffine(); return { vote: v.vote, stake: v.stake.toString(), pk: '0x' + fp(a.x) + fp(a.y) } }),
    sig: '0x' + fp(S.x.c0) + fp(S.x.c1) + fp(S.y.c0) + fp(S.y.c1),
  }, null, 2))
  console.log('wrote out/real-cert.json')
}
