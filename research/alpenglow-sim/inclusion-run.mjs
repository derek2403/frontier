// Need 2 check on our local Alpenglow node:
//   1. send a SODA approval (Memo) and wait until it is finalized
//   2. take the REAL finality certificate for its block from the footer stream
//   3. build the inclusion proof from raw shreds (inclusion/ Rust tool)
//   4. confirm: proof root == block_id in the blockstore == block_id the certificate signs
//
// Usage: node inclusion-run.mjs

import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { RPC, collectFooterCerts } from './local-cert.mjs'

const TOOL = process.env.INCLUSION_TOOL || new URL('./inclusion/target/release/inclusion', import.meta.url).pathname
const LEDGER = new URL('./node/ledger', import.meta.url).pathname
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))))
const conn = new Connection(RPC, 'confirmed')
const certs = new Map()
const streaming = collectFooterCerts(15_000, (c) => certs.set(Number(c.slot), c))

const memo = `SODA alpenglow approval v1|inclusion test|${new Date().toISOString()}`
const t = new Transaction().add(new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo) }))
t.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
t.feePayer = owner.publicKey
t.sign(owner)
const wire = t.serialize()
const sig = await conn.sendRawTransaction(wire)
let slot
for (;;) {
  const s = (await conn.getSignatureStatuses([sig])).value[0]
  if (s?.confirmationStatus === 'finalized') { slot = s.slot; break }
  await new Promise((r) => setTimeout(r, 100))
}
console.log(`approval ${sig}\nslot ${slot}, ${wire.length} bytes`)

let cert
for (let i = 0; i < 100 && !(cert = certs.get(slot)); i++) await new Promise((r) => setTimeout(r, 100))
if (!cert) throw new Error(`no certificate for slot ${slot}`)
const certBlockId = Buffer.from((cert.notar_aggregate ?? cert.final_aggregate).block_id).toString('hex')

// The blockstore writes the double Merkle meta when the slot completes; give it a moment.
let out
for (let i = 0; i < 20; i++) {
  try { out = JSON.parse(execFileSync(TOOL, [LEDGER, String(slot), wire.toString('hex')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); break } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)) }
}
console.log(`\nblock: ${out.dataShreds} data shreds in ${out.fecSetCount} FEC set(s), parent slot ${out.parentSlot}`)
console.log(`transaction at byte ${out.txOffsetInStream} of the block stream, spans ${out.shreds.length} shred(s)`)
console.log(`block_id from our proof     ${out.blockIdRecomputed}`)
console.log(`block_id in the blockstore  ${out.blockIdStored}`)
console.log(`block_id the cert signs     ${certBlockId}`)
const ok = out.match && out.blockIdRecomputed === certBlockId
console.log(ok ? '\nINCLUSION PROOF REACHES THE CERTIFIED block_id' : '\nMISMATCH')
fs.writeFileSync(new URL('./out/inclusion-proof.json', import.meta.url), JSON.stringify({ approval: sig, certBlockId, ...out }, null, 2))
await streaming
process.exit(ok ? 0 : 1)
