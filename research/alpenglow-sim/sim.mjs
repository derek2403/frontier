// Alpenglow-style light-client experiment on Base Sepolia.
//
// Measures gas, fees and wall-clock time for: deploying the contracts, a
// validator-set update, certificate checks with 0 / 50 / 150 non-signers
// out of 1,000 simulated validators, and a real Aave V3 deposit made by a
// SODA smart account (first call deploys it). Also times real Solana devnet
// finality (devnet runs Alpenglow) and reads the MPC baseline transaction.
//
// Usage: node sim.mjs            (reads SEPOLIA_FUNDER_KEY from ../../.env)

import fs from 'node:fs'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { bls12_381 as bls } from '@noble/curves/bls12-381.js'
import {
  createPublicClient, createWalletClient, http, keccak256, encodePacked, encodeFunctionData,
  parseEther, formatEther, toHex, concatHex, parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia, base } from 'viem/chains'
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js'

const N_VALIDATORS = 1000
const NON_SIGNER_CASES = [0, 50, 150]
const THRESHOLD_PCT = 60n
const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_'
const AAVE_GATEWAY = '0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6'
const AAVE_POOL = '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27'
const MPC_BASELINE_TX = '0x12acc10c2b9544e7861ae2413fd28a6b265c07dc03e15a91799b402be26621bb'
const DEPOSIT = parseEther('0.0001')

const env = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8')
const funderKey = env.match(/^SEPOLIA_FUNDER_KEY=(.*)$/m)[1].trim()
const account = privateKeyToAccount(funderKey.startsWith('0x') ? funderKey : `0x${funderKey}`)
const pub = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') })
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http('https://sepolia.base.org') })
const C = JSON.parse(fs.readFileSync(new URL('./out/AlpenglowSim.json', import.meta.url), 'utf8'))

// ---- encoding (EIP-2537: each Fp element is 64 bytes, big endian) ----
const fp = (x) => x.toString(16).padStart(128, '0')
const g1 = (P) => { const a = P.toAffine(); return `0x${fp(a.x)}${fp(a.y)}` }
const g2 = (P) => { const a = P.toAffine(); return `0x${fp(a.x.c0)}${fp(a.x.c1)}${fp(a.y.c0)}${fp(a.y.c1)}` }
const R = bls.fields.Fr.ORDER
const G1 = bls.G1.Point
const sortedHash = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a])))

function merkle(leaves) {
  const levels = [leaves]
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1), next = []
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? sortedHash(cur[i], cur[i + 1]) : cur[i])
    levels.push(next)
  }
  const proof = (idx) => {
    const p = []
    for (let l = 0; l < levels.length - 1; l++) {
      const sib = idx ^ 1
      if (sib < levels[l].length) p.push(levels[l][sib])
      idx >>= 1
    }
    return p
  }
  return { root: levels.at(-1)[0], proof }
}

// ---- tx helper: send, wait, record gas, L1 fee, total fee and time ----
const rows = []
async function tx(label, send) {
  const t0 = performance.now()
  const hash = await send()
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 })
  const ms = Math.round(performance.now() - t0)
  if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`)
  const t = await pub.getTransaction({ hash })
  const l2Fee = r.gasUsed * r.effectiveGasPrice
  const l1Fee = r.l1Fee ?? 0n
  const row = { label, hash, gasUsed: Number(r.gasUsed), l1Fee, l2Fee, fee: l1Fee + l2Fee, bytes: (t.input.length - 2) / 2, ms }
  rows.push(row)
  console.log(`${label.padEnd(44)} gas ${String(row.gasUsed).padStart(9)}  fee ${formatEther(row.fee).padStart(22)} ETH  ${String(ms).padStart(6)} ms`)
  return r
}
const deploy = (name, args) => () => wallet.deployContract({ abi: C[name].abi, bytecode: C[name].bytecode, args })
const call = (address, name, fn, args, value) => () =>
  wallet.writeContract({ address, abi: C[name].abi, functionName: fn, args, value })

async function main() {
  console.log(`funder ${account.address}`)

  // ---- 1. simulated validator set ----
  const vals = []
  let totalStake = 0n
  for (let i = 0; i < N_VALIDATORS; i++) {
    const sk = BigInt(toHex(randomBytes(32))) % R
    const stake = 1000n + BigInt(Math.floor(Math.random() * 99000))
    const pk = G1.BASE.multiply(sk)
    const pkHex = g1(pk)
    vals.push({ sk, stake, pk, pkHex, leaf: keccak256(encodePacked(['bytes', 'uint64'], [pkHex, stake])) })
    totalStake += stake
  }
  const vTree = merkle(vals.map((v) => v.leaf))
  const aggPk = vals.reduce((acc, v) => acc.add(v.pk), G1.ZERO)
  console.log(`validators ${N_VALIDATORS}, total stake ${totalStake}`)

  // ---- 2. deploy ----
  const lcR = await tx('deploy light client', deploy('SolanaLightClient', [toHex(DST), g1(G1.BASE.negate()), THRESHOLD_PCT]))
  const lc = lcR.contractAddress
  const fR = await tx('deploy account factory', deploy('SodaAccountFactory', [lc]))
  const factory = fR.contractAddress
  await tx('epoch update (simulated, admin)', call(lc, 'SolanaLightClient', 'setEpoch', [g1(aggPk), totalStake, vTree.root]))

  // ---- 3. the owner's approval (two actions: nonce 0 deploys, nonce 1 reuses) ----
  const owner = toHex(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8')))).publicKey.toBytes())
  const path = toHex(new Uint8Array(32))
  const acct = await pub.readContract({ address: factory, abi: C.SodaAccountFactory.abi, functionName: 'accountAddress', args: [owner, path] })
  console.log(`owner ${owner}\naccount ${acct}`)
  await tx('fund SODA account (0.00025 ETH)', () => wallet.sendTransaction({ to: acct, value: parseEther('0.00025') }))
  const depositData = encodeFunctionData({ abi: parseAbi(['function depositETH(address,address,uint16)']), args: [AAVE_POOL, acct, 0] })
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const approval = (nonce) => keccak256(encodePacked(
    ['uint256', 'address', 'bytes32', 'address', 'uint256', 'bytes32', 'uint64', 'uint64'],
    [BigInt(baseSepolia.id), acct, owner, AAVE_GATEWAY, DEPOSIT, keccak256(depositData), nonce, deadline],
  ))
  // Each certified block carries our approval plus three other approvals.
  const blockApprovals = (nonce) => {
    const leaves = [approval(nonce), ...[1, 2, 3].map(() => keccak256(toHex(randomBytes(32))))]
    const t = merkle(leaves)
    return { root: t.root, proof: t.proof(0) }
  }

  // ---- 4. certificates ----
  async function certify(nonSignerCount, approvals, label) {
    const blockId = keccak256(toHex(randomBytes(32)))
    const idx = [...vals.keys()].sort(() => Math.random() - 0.5).slice(0, nonSignerCount)
    const nonSet = new Set(idx)
    const signerSk = vals.reduce((acc, v, i) => (nonSet.has(i) ? acc : (acc + v.sk) % R), 0n)
    const msg = new TextEncoder().encode('SODA-alpenglow-sim')
    const m = new Uint8Array([...msg, ...Buffer.from(blockId.slice(2), 'hex'), ...Buffer.from(approvals.root.slice(2), 'hex')])
    const H = bls.G2.hashToCurve(m, { DST })
    const sig = H.multiply(signerSk)
    // Sanity: the same check the contract does, off-chain first.
    const signerPk = vals.reduce((acc, v, i) => (nonSet.has(i) ? acc : acc.add(v.pk)), G1.ZERO)
    if (!bls.fields.Fp12.eql(bls.pairing(signerPk, H), bls.pairing(G1.BASE, sig))) throw new Error('local BLS check failed')
    const nonSigners = idx
      .map((i) => ({ pk: vals[i].pkHex, stake: vals[i].stake, proof: vTree.proof(i), leaf: vals[i].leaf }))
      .sort((a, b) => (BigInt(a.leaf) < BigInt(b.leaf) ? -1 : 1))
      .map(({ pk, stake, proof }) => ({ pk, stake, proof }))
    await tx(label, call(lc, 'SolanaLightClient', 'submitCertificate', [blockId, approvals.root, g2(sig), nonSigners]))
    return blockId
  }

  const a0 = blockApprovals(0n)
  let block0
  for (const n of NON_SIGNER_CASES) {
    const b = await certify(n, n === 0 ? a0 : blockApprovals(0n), `certificate, ${n} of ${N_VALIDATORS} not signing`)
    if (n === 0) block0 = b
  }

  // ---- 5. the SODA account acts: real Aave deposit ----
  await tx('Aave deposit, first (deploys SODA account)', call(factory, 'SodaAccountFactory', 'deployAndExecute',
    [owner, path, AAVE_GATEWAY, DEPOSIT, depositData, 0n, deadline, block0, a0.proof]))
  const a1 = blockApprovals(1n)
  const block1 = await certify(0, a1, `certificate for 2nd action, 0 not signing`)
  await tx('Aave deposit, second (account exists)', call(acct, 'SodaAccount', 'execute',
    [AAVE_GATEWAY, DEPOSIT, depositData, 1n, deadline, block1, a1.proof]))

  // ---- 6. baselines and Solana timing ----
  const base0 = await pub.getTransactionReceipt({ hash: MPC_BASELINE_TX })
  const mpcBaseline = { gasUsed: Number(base0.gasUsed), fee: base0.gasUsed * base0.effectiveGasPrice + (base0.l1Fee ?? 0n) }
  console.log(`MPC baseline Aave deposit (normal address): gas ${mpcBaseline.gasUsed}, fee ${formatEther(mpcBaseline.fee)} ETH`)

  const solana = await solanaFinality(3)

  // ---- 7. project the same transactions onto Base mainnet prices ----
  const main = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') })
  const gasPrice = await main.getGasPrice()
  const oracle = '0x420000000000000000000000000000000000000F'
  const oAbi = parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)'])
  for (const r of rows) {
    const l1 = await main.readContract({ address: oracle, abi: oAbi, functionName: 'getL1FeeUpperBound', args: [BigInt(r.bytes + 120)] })
    r.mainnetFee = BigInt(r.gasUsed) * gasPrice + l1
  }
  const baseL1 = await main.readContract({ address: oracle, abi: oAbi, functionName: 'getL1FeeUpperBound', args: [400n] })
  mpcBaseline.mainnetFee = BigInt(mpcBaseline.gasUsed) * gasPrice + baseL1

  const result = {
    at: new Date().toISOString(), funder: account.address, lightClient: lc, factory, sodaAccount: acct,
    validators: N_VALIDATORS, thresholdPct: Number(THRESHOLD_PCT), baseMainnetGasPriceWei: gasPrice.toString(),
    rows: rows.map((r) => ({ ...r, l1Fee: r.l1Fee.toString(), l2Fee: r.l2Fee.toString(), fee: r.fee.toString(), mainnetFee: r.mainnetFee.toString() })),
    mpcBaseline: { ...mpcBaseline, fee: mpcBaseline.fee.toString(), mainnetFee: mpcBaseline.mainnetFee.toString() },
    solanaDevnetFinality: solana,
  }
  fs.writeFileSync(new URL('./out/results.json', import.meta.url), JSON.stringify(result, null, 2))
  console.log('\nBase mainnet projection (gas price', gasPrice.toString(), 'wei):')
  for (const r of rows) console.log(`${r.label.padEnd(44)} ${formatEther(r.mainnetFee).padStart(22)} ETH`)
  console.log(`${'MPC baseline Aave deposit'.padEnd(44)} ${formatEther(mpcBaseline.mainnetFee).padStart(22)} ETH`)
  console.log('\nSolana devnet (Alpenglow) finality, ms:', JSON.stringify(solana))
  console.log('wrote out/results.json')
}

async function solanaFinality(runs) {
  const devnetRpc = env.match(/^SOLANA_DEVNET_RPC_URL=(.*)$/m)?.[1].trim() || 'https://api.devnet.solana.com'
  const conn = new Connection(devnetRpc, 'processed')
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))))
  const out = []
  for (let i = 0; i < runs; i++) {
    const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 + i }))
    t.recentBlockhash = (await conn.getLatestBlockhash('finalized')).blockhash
    t.feePayer = kp.publicKey
    t.sign(kp)
    const t0 = performance.now()
    const sig = await conn.sendRawTransaction(t.serialize(), { skipPreflight: true })
    const seen = {}
    while (!seen.finalized && performance.now() - t0 < 60000) {
      const s = (await conn.getSignatureStatuses([sig])).value[0]
      if (s?.confirmationStatus && !seen[s.confirmationStatus]) seen[s.confirmationStatus] = Math.round(performance.now() - t0)
      if (s?.confirmationStatus === 'finalized') { seen.confirmed ??= seen.finalized; seen.processed ??= seen.confirmed }
      await new Promise((r) => setTimeout(r, 100))
    }
    out.push({ sig, ...seen })
  }
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
