// Finds which 672 of today's mainnet BLS keys formed the validator list at
// the Alpenglow switch (slot 459,652,999), then checks the genesis
// certificate with the official rank order and reports the signed stake.
import fs from 'node:fs'
import { bls12_381 as bls } from '@noble/curves/bls12-381.js'
const RPC = 'https://api.mainnet-beta.solana.com'
const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_'
const rpc = async (m, p = []) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result }
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c)); const o = []; while (n > 0n) { o.unshift(Number(n & 255n)); n >>= 8n } for (const c of s) { if (c === '1') o.unshift(0); else break } return Uint8Array.from(o) }
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }

const cert = await rpc('getAgGenesisCert')
const bm = cert.signature.bitmap, nBits = bm[1] | (bm[2] << 8)
const signerRanks = []; for (let i = 0; i < nBits; i++) if (bm[3 + (i >> 3)] & (1 << (i & 7))) signerRanks.push(i)
const sv = (await rpc('getClusterNodes')).map((n) => n.shredVersion).find(Boolean)
const payload = new Uint8Array(43); const dv = new DataView(payload.buffer)
payload[0] = 6; dv.setBigUint64(1, BigInt(cert.block.slot), true); payload.set(cert.block.blockId, 9); dv.setUint16(41, sv, true)
const H = bls.G2.hashToCurve(payload, { DST })
const target = bls.pairing(bls.G1.Point.BASE, bls.G2.Point.fromBytes(Uint8Array.from(cert.signature.signature)))

const va = await rpc('getVoteAccounts')
const all = [...va.current, ...va.delinquent].filter((v) => v.activatedStake > 0)
const infos = []; for (let i = 0; i < all.length; i += 100) infos.push(...(await rpc('getMultipleAccounts', [all.slice(i, i + 100).map((v) => v.votePubkey), { encoding: 'jsonParsed' }])).value)
const vals = all.map((v, i) => ({ v, k: infos[i]?.data?.parsed?.info?.blsPubkeyCompressed })).filter((x) => x.k)
  .map(({ v, k }) => ({ vote: v.votePubkey, stake: BigInt(v.activatedStake), epochVote: v.epochVoteAccount, c: b58(k), pk: bls.G1.Point.fromBytes(b58(k)) }))
  .sort((a, b) => (a.stake === b.stake ? cmp(a.c, b.c) : a.stake > b.stake ? -1 : 1))
console.log(`ranked at switch: ${nBits}, signed: ${signerRanks.length}; BLS keys today: ${vals.length}; shred version ${sv}`)

let tries = 0
const test = (list) => { tries++; const agg = signerRanks.reduce((a, r) => a.add(list[r].pk), bls.G1.Point.ZERO); return bls.fields.Fp12.eql(bls.pairing(agg, H), target) }
const report = (list, why) => {
  const total = list.reduce((a, v) => a + v.stake, 0n), signed = signerRanks.reduce((a, r) => a + list[r].stake, 0n)
  console.log(`\nVERIFIED (${why}) after ${tries} tries`)
  console.log(`stake signed: ${signed / 10n ** 9n} of ${total / 10n ** 9n} SOL = ${(Number((signed * 10000n) / total) / 100).toFixed(2)}% (today's stake; genesis threshold is checked by Agave)`)
  fs.writeFileSync(new URL('./out/real-cert-mainnet.json', import.meta.url), JSON.stringify({ slot: cert.block.slot, signers: signerRanks.length, ranked: nBits, signedStakePct: Number((signed * 10000n) / total) / 100, excluded: vals.filter((v) => !list.includes(v)).map((v) => v.vote) }, null, 2))
  process.exit(0)
}
const extra = vals.length - nBits
console.log(`need to drop ${extra} key(s)`)
// 1. accounts not staked for this epoch first
const notEpoch = vals.filter((v) => !v.epochVote)
console.log(`not staked this epoch: ${notEpoch.length}`)
const combos = (arr, k, start = 0, cur = [], out = []) => { if (cur.length === k) { out.push([...cur]); return out } for (let i = start; i < arr.length; i++) { cur.push(arr[i]); combos(arr, k, i + 1, cur, out); cur.pop() } return out }
if (extra > 0) for (const drop of combos(notEpoch, Math.min(extra, notEpoch.length))) {
  const list = vals.filter((v) => !drop.includes(v)); if (list.length !== nBits) continue
  if (test(list)) report(list, 'dropped not-staked accounts')
}
// 2. then every pair (or single) by brute force, lowest-stake first
const order = [...vals].reverse()
const t0 = performance.now()
for (const drop of combos(order, extra)) {
  const list = vals.filter((v) => !drop.includes(v))
  if (test(list)) report(list, 'search')
  if (tries % 2000 === 0) console.log(`${tries} tries, ${Math.round((performance.now() - t0) / 1000)} s`)
}
console.log('NOT verified')
