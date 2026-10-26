// End to end with REAL Alpenglow certificates from our local Alpenglow node:
//
//   1. the owner signs a Memo approval on the local Alpenglow network
//   2. our node's Yellowstone gRPC streams the block footer holding the
//      finality certificate for that block (real BLS, real format)
//   3. AlpenglowLightClient on Base Sepolia checks it against the validator
//      set read from the node: bitmap, stake rule, BLS pairing
//   4. the attester posts the approvals root for that block  (NOT proved:
//      the inclusion proof does not exist yet)
//   5. the owner's SodaAccount makes a real Aave V3 deposit
//
// Usage: node local-flow.mjs            (deploys on first run, reuses after)
//        node local-flow.mjs --redeploy

import fs from 'node:fs'
import os from 'node:os'
import { bls12_381 as bls } from '@noble/curves/bls12-381.js'
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import {
  createPublicClient, createWalletClient, http, keccak256, encodePacked, encodeFunctionData, parseAbi, parseEther, formatEther, toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { RPC, readValidatorSet, collectFooterCerts, certPayload, verifyAggregate } from './local-cert.mjs'

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const AAVE_GATEWAY = '0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6'
const AAVE_POOL = '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27'
const A_WETH = '0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb'
const DEPOSIT = parseEther('0.0001')
const OUT = new URL('./out/local-deployment.json', import.meta.url)

const env = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8')
const funder = privateKeyToAccount(`0x${env.match(/^SEPOLIA_FUNDER_KEY=(.*)$/m)[1].trim().replace(/^0x/, '')}`)
const BASE = 'https://sepolia.base.org'
const pub = createPublicClient({ chain: baseSepolia, transport: http(BASE) })
const wallet = createWalletClient({ account: funder, chain: baseSepolia, transport: http(BASE) })
const C = JSON.parse(fs.readFileSync(new URL('./out/AlpenglowSim.json', import.meta.url), 'utf8'))
const fp = (x) => x.toString(16).padStart(128, '0')
const g1 = (P) => { const a = P.toAffine(); return `0x${fp(a.x)}${fp(a.y)}` }
const g2 = (bytes) => { const a = bls.G2.Point.fromBytes(bytes).toAffine(); return `0x${fp(a.x.c0)}${fp(a.x.c1)}${fp(a.y.c0)}${fp(a.y.c1)}` }
const hx = (b) => `0x${Buffer.from(b).toString('hex')}`

const rows = []
async function tx(label, send) {
  const t0 = performance.now()
  const hash = await send()
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 })
  const ms = Math.round(performance.now() - t0)
  if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`)
  rows.push({ label, hash, gas: Number(r.gasUsed), ms })
  console.log(`  ${label.padEnd(38)} gas ${String(r.gasUsed).padStart(8)}  ${String(ms).padStart(5)} ms  ${hash}`)
  return r
}
const retryRead = async (fn, ok, n = 20) => { let v; for (let i = 0; i < n; i++) { v = await fn(); if (ok(v)) return v; await new Promise((r) => setTimeout(r, 250)) } return v }

// ---- validator set from the local node ----
const { vals, shredVersion } = await readValidatorSet()
console.log(`local Alpenglow node: ${vals.length} validator(s), shred version ${shredVersion}`)

// ---- deploy (once) ----
let dep = fs.existsSync(OUT) && !process.argv.includes('--redeploy') ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null
if (dep && dep.shredVersion !== shredVersion) { console.log('node was reset (new shred version); redeploying'); dep = null }
if (!dep) {
  console.log('deploying to Base Sepolia:')
  const negG1 = g1(bls.G1.Point.BASE.negate())
  const lc = (await tx('deploy AlpenglowLightClient', () => wallet.deployContract({ abi: C.AlpenglowLightClient.abi, bytecode: C.AlpenglowLightClient.bytecode, args: [negG1, funder.address] }))).contractAddress
  const factory = (await tx('deploy SodaAccountFactory', () => wallet.deployContract({ abi: C.SodaAccountFactory.abi, bytecode: C.SodaAccountFactory.bytecode, args: [lc] }))).contractAddress
  await tx('load validator set (admin)', () => wallet.writeContract({ address: lc, abi: C.AlpenglowLightClient.abi, functionName: 'setValidators', args: [vals.map((v) => g1(v.pk)), vals.map((v) => v.stake), shredVersion] }))
  dep = { lightClient: lc, factory, shredVersion, validators: vals.map((v) => ({ vote: v.vote, stake: v.stake.toString() })) }
  fs.writeFileSync(OUT, JSON.stringify(dep, null, 2))
}
console.log(`light client ${dep.lightClient}\nfactory      ${dep.factory}`)

// ---- owner and account ----
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))))
const ownerHex = toHex(owner.publicKey.toBytes())
const path = toHex(new Uint8Array(32))
const acct = await pub.readContract({ address: dep.factory, abi: C.SodaAccountFactory.abi, functionName: 'accountAddress', args: [ownerHex, path] })
const code = await pub.getCode({ address: acct })
const deployed = !!code && code !== '0x'
const nonce = deployed ? await pub.readContract({ address: acct, abi: C.SodaAccount.abi, functionName: 'nonce' }) : 0n
console.log(`owner ${owner.publicKey.toBase58()}\nSODA account ${acct} (${deployed ? `deployed, nonce ${nonce}` : 'not deployed yet'})`)
if ((await pub.getBalance({ address: acct })) < DEPOSIT) await tx('fund SODA account 0.0003 ETH', () => wallet.sendTransaction({ to: acct, value: parseEther('0.0003') }))

// ---- 1. approval on the local Alpenglow network ----
const data = encodeFunctionData({ abi: parseAbi(['function depositETH(address,address,uint16)']), args: [AAVE_POOL, acct, 0] })
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
const memo = ['SODA cross-chain action v1', 'action=aave-v3-deposit', `chain=${baseSepolia.id}`, `account=${acct}`, `target=${AAVE_GATEWAY}`, `value=${DEPOSIT}`, `data=${keccak256(data)}`, `nonce=${nonce}`, `deadline=${deadline}`].join('|')
const leaf = keccak256(encodePacked(['uint256', 'address', 'bytes32', 'address', 'uint256', 'bytes32', 'uint64', 'uint64'], [BigInt(baseSepolia.id), acct, ownerHex, AAVE_GATEWAY, DEPOSIT, keccak256(data), nonce, deadline]))

const conn = new Connection(RPC, 'processed')
// Start reading footers before sending, so the certificate cannot be missed.
const certs = new Map()
const streaming = collectFooterCerts(20_000, (c) => certs.set(Number(c.slot), c))
const t0 = performance.now()
const t = new Transaction().add(new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo) }))
t.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
t.feePayer = owner.publicKey
t.sign(owner)
const sig = await conn.sendRawTransaction(t.serialize())
let slot
for (;;) {
  const s = (await conn.getSignatureStatuses([sig])).value[0]
  if (s?.err) throw new Error('approval failed')
  if (s?.confirmationStatus === 'finalized') { slot = s.slot; break }
  await new Promise((r) => setTimeout(r, 50))
}
const finalMs = Math.round(performance.now() - t0)
console.log(`\n1. approval ${sig}\n   slot ${slot}, finalized in ${finalMs} ms on the local Alpenglow network`)

// ---- 2. the real certificate for that slot, from the block footer ----
let cert
for (let i = 0; i < 100 && !(cert = certs.get(slot)); i++) await new Promise((r) => setTimeout(r, 100))
if (!cert) throw new Error(`no finality certificate seen for slot ${slot}`)
const fast = !cert.notar_aggregate
const blockId = (cert.notar_aggregate ?? cert.final_aggregate).block_id
const pct = fast
  ? verifyAggregate(cert.final_aggregate, certPayload(1, slot, blockId, shredVersion), vals)
  : Math.min(verifyAggregate(cert.final_aggregate, certPayload(2, slot, null, shredVersion), vals), verifyAggregate(cert.notar_aggregate, certPayload(1, slot, blockId, shredVersion), vals))
console.log(`2. certificate for slot ${slot}: ${fast ? 'fast' : 'slow'} finality, block_id ${hx(blockId)}, ${pct}% stake, checked off-chain: VALID`)

// ---- 3. Base checks the certificate ----
console.log('3-5. Base Sepolia:')
await tx('submitFinalCert (real certificate)', () => wallet.writeContract({
  address: dep.lightClient, abi: C.AlpenglowLightClient.abi, functionName: 'submitFinalCert',
  args: [BigInt(slot), hx(blockId), g2(cert.final_aggregate.signature), hx(cert.final_aggregate.signer_bitmap), fast ? '0x' : g2(cert.notar_aggregate.signature), fast ? '0x' : hx(cert.notar_aggregate.signer_bitmap)],
}))
await retryRead(() => pub.readContract({ address: dep.lightClient, abi: C.AlpenglowLightClient.abi, functionName: 'finalizedSlot', args: [hx(blockId)] }), (v) => v !== 0n)

// ---- 4. attester posts the approvals root (single approval: root = leaf) ----
await tx('attestApprovals (NOT proved)', () => wallet.writeContract({ address: dep.lightClient, abi: C.AlpenglowLightClient.abi, functionName: 'attestApprovals', args: [hx(blockId), leaf] }))
await retryRead(() => pub.readContract({ address: dep.lightClient, abi: C.AlpenglowLightClient.abi, functionName: 'finalized', args: [hx(blockId)] }), (v) => !/^0x0+$/.test(v))

// ---- 5. the SODA account acts ----
await tx(deployed ? 'Aave deposit' : 'Aave deposit (deploys account)', () => deployed
  ? wallet.writeContract({ address: acct, abi: C.SodaAccount.abi, functionName: 'execute', args: [AAVE_GATEWAY, DEPOSIT, data, nonce, deadline, hx(blockId), []] })
  : wallet.writeContract({ address: dep.factory, abi: C.SodaAccountFactory.abi, functionName: 'deployAndExecute', args: [ownerHex, path, AAVE_GATEWAY, DEPOSIT, data, nonce, deadline, hx(blockId), []] }))
const aWeth = await retryRead(() => pub.readContract({ address: A_WETH, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [acct] }), () => true)
console.log(`\naWETH held by the SODA account: ${formatEther(aWeth)}`)
console.log(`total: ${Math.round(performance.now() - t0)} ms from approval to deposit`)
await streaming
fs.writeFileSync(new URL('./out/local-flow-last.json', import.meta.url), JSON.stringify({ approval: sig, slot, blockId: hx(blockId), fast, signedStakePct: pct, finalMs, txs: rows, account: acct, aWeth: aWeth.toString() }, null, 2))
process.exit(0)
