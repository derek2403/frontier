/**
 * One-shot Distributed Key Generation ceremony.
 *
 * Runs both P1 and P2 contexts in the same Node process and exchanges the
 * three DKG protocol messages between them in-memory. Outputs two share
 * files (one per node) and a `group-pk.json` with the X / Y coordinates of
 * the joint public key.
 *
 * Production note: in v1, this ceremony should be done with each node on
 * separate hardware (so the orchestrator never sees both shares). For the
 * hackathon demo we run it locally and then ship the share files to each
 * AWS host. That's the same trust model as v0's `keyshare.dev.json`, just
 * split in two.
 *
 * Usage:
 *   pnpm dkg ./shares/share-a.json ./shares/share-b.json
 */

import pkg from '@safeheron/two-party-ecdsa-js'
import { saveShare, type ShareFile } from '../src/share.js'

const { TPCEcdsaKeyGen } = pkg

const [pathA, pathB] = process.argv.slice(2)
if (!pathA || !pathB) {
  console.error('Usage: pnpm dkg <share-a-path> <share-b-path>')
  process.exit(2)
}

console.log('Starting 2-of-2 DKG ceremony...')

const p1 = await TPCEcdsaKeyGen.P1Context.createContext()
const p2 = await TPCEcdsaKeyGen.P2Context.createContext()

const m1 = p1.step1()
console.log(`  P1 → message1 (${m1.length} bytes)`)

const m2 = p2.step1(m1)
console.log(`  P2 → message2 (${m2.length} bytes)`)

const m3 = p1.step2(m2)
console.log(`  P1 → message3 (${m3.length} bytes)`)

p2.step2(m3)
console.log('  P2 verified, ceremony complete')

const ks1 = p1.exportKeyShare()
const ks2 = p2.exportKeyShare()

const groupQ = ks1.Q
if (!groupQ.getX().eq(ks2.Q.getX()) || !groupQ.getY().eq(ks2.Q.getY())) {
  throw new Error('group public point mismatch — ceremony failed')
}

const groupPkXY = {
  x: Buffer.from(groupQ.getX().toArray('be', 32)).toString('hex'),
  y: Buffer.from(groupQ.getY().toArray('be', 32)).toString('hex'),
}

const fileA: ShareFile = {
  role: 'p1',
  groupPkXY,
  share: ks1.toJsonObject(),
}
const fileB: ShareFile = {
  role: 'p2',
  groupPkXY,
  share: ks2.toJsonObject(),
}

saveShare(pathA, fileA)
saveShare(pathB, fileB)

console.log()
console.log('Ceremony output:')
console.log(`  group_pk.x = ${groupPkXY.x}`)
console.log(`  group_pk.y = ${groupPkXY.y}`)
console.log(`  share-a    → ${pathA}`)
console.log(`  share-b    → ${pathB}`)
console.log()
console.log('Next steps:')
console.log('  1. Move share-a to mpc-node-a host (DO NOT keep it on the orchestrator).')
console.log('  2. Move share-b to mpc-node-b host (different host / region / cloud).')
console.log('  3. Update the soda Committee PDA group_pk_xy with the values above.')
