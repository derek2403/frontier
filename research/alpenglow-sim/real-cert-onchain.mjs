// Checks the REAL devnet Alpenglow certificate (out/real-cert.json, from
// real-cert.mjs) on Base Sepolia with AlpenglowCertCheck. Deploys the
// contract, compares its payload bytes with Agave's, runs the check as a
// free call, a tampered call (must fail), then records it in a transaction.
//
// Usage: node real-cert-onchain.mjs   (reads SEPOLIA_FUNDER_KEY from ../../.env)

import fs from 'node:fs'
import { bls12_381 as bls } from '@noble/curves/bls12-381.js'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const env = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8')
const key = env.match(/^SEPOLIA_FUNDER_KEY=(.*)$/m)[1].trim().replace(/^0x/, '')
const RPC = 'https://sepolia.base.org'
const account = privateKeyToAccount(`0x${key}`)
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) })
const C = JSON.parse(fs.readFileSync(new URL('./out/AlpenglowSim.json', import.meta.url), 'utf8')).AlpenglowCertCheck
const cert = JSON.parse(fs.readFileSync(new URL('./out/real-cert.json', import.meta.url), 'utf8'))

const fp = (x) => x.toString(16).padStart(128, '0')
const n = bls.G1.Point.BASE.negate().toAffine()
const negG1 = `0x${fp(n.x)}${fp(n.y)}`

const dh = await wallet.deployContract({ abi: C.abi, bytecode: C.bytecode, args: [negG1] })
const address = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress
console.log(`AlpenglowCertCheck ${address} (deploy ${dh})`)

const args = [cert.tag, BigInt(cert.slot), cert.blockId, cert.shredVersion, cert.signers.map((s) => s.pk), cert.sig]
const read = (fn, a) => pub.readContract({ address, abi: C.abi, functionName: fn, args: a })

const onchainPayload = await read('payload', args.slice(0, 4))
console.log(`payload on-chain ${onchainPayload}\npayload Agave    ${cert.payload}\nmatch: ${onchainPayload === cert.payload}`)

console.log(`verify(real certificate): ${await read('verify', args)}`)
const tampered = [...args]
tampered[1] = BigInt(cert.slot) + 1n
console.log(`verify(slot + 1, must be false): ${await read('verify', tampered)}`)
const fewer = [...args]
fewer[4] = args[4].slice(1)
console.log(`verify(one signer removed, must be false): ${await read('verify', fewer)}`)

const t0 = performance.now()
const h = await wallet.writeContract({ address, abi: C.abi, functionName: 'record', args })
const r = await pub.waitForTransactionReceipt({ hash: h, pollingInterval: 250 })
console.log(`record tx ${h}: ${r.status}, gas ${r.gasUsed}, ${Math.round(performance.now() - t0)} ms`)

fs.writeFileSync(new URL('./out/real-cert-onchain.json', import.meta.url), JSON.stringify({ address, deployTx: dh, recordTx: h, gasUsed: Number(r.gasUsed), status: r.status, signers: cert.signers.length }, null, 2))
