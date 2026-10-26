// Checks the shred inclusion proof from out/inclusion-proof.json on Base
// Sepolia with ShredInclusion, and measures its gas. The proof must rebuild
// the block_id that the real Alpenglow certificate signed.
//
// Usage: node inclusion-onchain.mjs   (run inclusion-run.mjs first)

import fs from 'node:fs'
import { Connection } from '@solana/web3.js'
import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { RPC } from './local-cert.mjs'

const env = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8')
const account = privateKeyToAccount(`0x${env.match(/^SEPOLIA_FUNDER_KEY=(.*)$/m)[1].trim().replace(/^0x/, '')}`)
const pub = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') })
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http('https://sepolia.base.org') })
const C = JSON.parse(fs.readFileSync(new URL('./out/AlpenglowSim.json', import.meta.url), 'utf8')).ShredInclusion
const P = JSON.parse(fs.readFileSync(new URL('./out/inclusion-proof.json', import.meta.url), 'utf8'))
if (P.shreds.length !== 1) throw new Error('this check handles a transaction inside one shred')

const tx = await new Connection(RPC).getTransaction(P.approval, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
const raw = tx.transaction.message.serialize ? null : null
// Rebuild the wire bytes the same way the block stores them.
const { VersionedTransaction } = await import('@solana/web3.js')
const wire = `0x${Buffer.from(new VersionedTransaction(tx.transaction.message, tx.transaction.signatures.map((s) => Buffer.from(require58(s)))).serialize()).toString('hex')}`
function require58(s) { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const o = []; while (n > 0n) { o.unshift(Number(n & 255n)); n >>= 8n } for (const c of s) { if (c === '1') o.unshift(0); else break } return Uint8Array.from(o) }

const s = P.shreds[0]
const args = [
  `0x${s.leafBytes}`,
  BigInt(s.index - s.fecSetIndex),
  s.shredProof.map((h) => `0x${h}`),
  BigInt(s.fecSetIndex / 32),
  s.doubleProof.map((h) => `0x${h}`),
  wire,
  BigInt(P.txOffsetInStream - s.dataStartInStream),
]

const dh = await wallet.deployContract({ abi: C.abi, bytecode: C.bytecode })
const address = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress
console.log(`ShredInclusion ${address}`)

const root = await pub.readContract({ address, abi: C.abi, functionName: 'blockId', args })
console.log(`block_id from the on-chain check  ${root.slice(2)}`)
console.log(`block_id the certificate signed   ${P.certBlockId}`)
console.log(`match: ${root.slice(2) === P.certBlockId}`)

const data = encodeFunctionData({ abi: C.abi, functionName: 'blockId', args })
const gas = await pub.estimateGas({ account: account.address, to: address, data })
console.log(`gas for the check (one transaction on its own, incl. 21,000 base + calldata): ${gas}`)
console.log(`calldata: ${(data.length - 2) / 2} bytes`)

const bad = [...args]; bad[5] = wire.slice(0, -2) + (wire.endsWith('00') ? '01' : '00')
try { await pub.readContract({ address, abi: C.abi, functionName: 'blockId', args: bad }); console.log('changed transaction: ACCEPTED (wrong)') } catch { console.log('changed transaction: rejected') }
const bad2 = [...args]; bad2[2] = [...args[2]]; bad2[2][0] = `0x${'11'.repeat(20)}`
const r2 = await pub.readContract({ address, abi: C.abi, functionName: 'blockId', args: bad2 })
console.log(`changed proof entry: root ${r2.slice(2) === P.certBlockId ? 'MATCHES (wrong)' : 'differs (rejected)'}`)
fs.writeFileSync(new URL('./out/inclusion-onchain.json', import.meta.url), JSON.stringify({ address, gas: gas.toString(), calldataBytes: (data.length - 2) / 2, match: root.slice(2) === P.certBlockId }, null, 2))
