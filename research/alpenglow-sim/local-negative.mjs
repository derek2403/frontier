// Takes one REAL certificate from our local Alpenglow node and asks the Base
// Sepolia light client (eth_call, no gas) to accept it unchanged and with
// one field changed at a time. Only the unchanged one may pass.
import fs from 'node:fs'
import { bls12_381 as bls } from '@noble/curves/bls12-381.js'
import { createPublicClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'
import { readValidatorSet, collectFooterCerts } from './local-cert.mjs'

const C = JSON.parse(fs.readFileSync(new URL('./out/AlpenglowSim.json', import.meta.url), 'utf8')).AlpenglowLightClient
const dep = JSON.parse(fs.readFileSync(new URL('./out/local-deployment.json', import.meta.url), 'utf8'))
const env = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8')
const pub = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') })
const fp = (x) => x.toString(16).padStart(128, '0')
const g2 = (b) => { const a = bls.G2.Point.fromBytes(b).toAffine(); return `0x${fp(a.x.c0)}${fp(a.x.c1)}${fp(a.y.c0)}${fp(a.y.c1)}` }
const hx = (b) => `0x${Buffer.from(b).toString('hex')}`

await readValidatorSet()
const certs = await collectFooterCerts(3000)
const [slot, c] = [...certs.entries()].at(-1)
const blockId = hx(c.final_aggregate.block_id)
const sig = g2(c.final_aggregate.signature)
const bm = hx(c.final_aggregate.signer_bitmap)
const otherSig = g2([...certs.values()].at(-2).final_aggregate.signature)

const cases = [
  ['real certificate, unchanged', [BigInt(slot), blockId, sig, bm, '0x', '0x']],
  ['slot + 1', [BigInt(slot + 1), blockId, sig, bm, '0x', '0x']],
  ['block_id changed', [BigInt(slot), `0x${'11'.repeat(32)}`, sig, bm, '0x', '0x']],
  ['signature from another block', [BigInt(slot), blockId, otherSig, bm, '0x', '0x']],
  ['bitmap: nobody signed', [BigInt(slot), blockId, sig, '0x00010000', '0x', '0x']],
]
for (const [name, args] of cases) {
  try {
    await pub.simulateContract({ address: dep.lightClient, abi: C.abi, functionName: 'submitFinalCert', args, account: '0x31777694F7b90b635B1F3B786f5D24be7651BE7B' })
    console.log(`${name.padEnd(32)} ACCEPTED`)
  } catch (e) {
    console.log(`${name.padEnd(32)} rejected: ${e.shortMessage?.split('\n').find((l) => l.includes('reverted')) ?? e.shortMessage}`)
  }
}
process.exit(0)
