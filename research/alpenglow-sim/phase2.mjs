// Second half of the experiment, kept separate so the Base Sepolia part does
// not have to run again: Solana devnet finality timing (devnet runs
// Alpenglow), and a projection of the last run's Base Sepolia transactions
// onto Base mainnet prices.
//
// Usage: node phase2.mjs <count of the funder's latest txs to project>

import fs from 'node:fs'
import os from 'node:os'
import { createPublicClient, http, parseAbi, formatEther } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js'

const FUNDER = '0x31777694F7b90b635B1F3B786f5D24be7651BE7B'
const COUNT = Number(process.argv[2] ?? 10)
const MPC_BASELINE_TX = '0x12acc10c2b9544e7861ae2413fd28a6b265c07dc03e15a91799b402be26621bb'
const sepolia = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') })
const main = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') })
const oracle = '0x420000000000000000000000000000000000000F'
const oAbi = parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)'])

async function solanaFinality(runs) {
  const conn = new Connection('https://api.devnet.solana.com', 'processed')
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
      await new Promise((r) => setTimeout(r, 300))
      const s = (await conn.getSignatureStatuses([sig])).value[0]
      if (s?.confirmationStatus && !seen[s.confirmationStatus]) seen[s.confirmationStatus] = Math.round(performance.now() - t0)
    }
    out.push({ sig, ...seen })
    await new Promise((r) => setTimeout(r, 2000))
  }
  return out
}

const res = await fetch(`https://base-sepolia.blockscout.com/api/v2/addresses/${FUNDER}/transactions`)
const items = (await res.json()).items.slice(0, COUNT).reverse()
const gasPrice = await main.getGasPrice()
const rows = []
for (const it of items) {
  const t = await sepolia.getTransaction({ hash: it.hash })
  const r = await sepolia.getTransactionReceipt({ hash: it.hash })
  const bytes = (t.input.length - 2) / 2
  const l1 = await main.readContract({ address: oracle, abi: oAbi, functionName: 'getL1FeeUpperBound', args: [BigInt(bytes + 120)] })
  const mainnetFee = r.gasUsed * gasPrice + l1
  rows.push({ hash: it.hash, method: it.method, gasUsed: Number(r.gasUsed), bytes, mainnetFeeEth: formatEther(mainnetFee), mainnetL1Eth: formatEther(l1), mainnetL2Eth: formatEther(r.gasUsed * gasPrice) })
  console.log(`${String(it.method ?? 'transfer').padEnd(20)} gas ${String(r.gasUsed).padStart(8)}  bytes ${String(bytes).padStart(6)}  mainnet ${formatEther(mainnetFee).padStart(20)} ETH (L2 ${formatEther(r.gasUsed * gasPrice)}, L1 ${formatEther(l1)})`)
}
const b = await sepolia.getTransactionReceipt({ hash: MPC_BASELINE_TX })
const bt = await sepolia.getTransaction({ hash: MPC_BASELINE_TX })
const bBytes = (bt.input.length - 2) / 2
const bL1 = await main.readContract({ address: oracle, abi: oAbi, functionName: 'getL1FeeUpperBound', args: [BigInt(bBytes + 120)] })
const baseline = { gasUsed: Number(b.gasUsed), bytes: bBytes, mainnetFeeEth: formatEther(b.gasUsed * gasPrice + bL1) }
console.log(`MPC baseline deposit   gas ${b.gasUsed}  bytes ${bBytes}  mainnet ${baseline.mainnetFeeEth} ETH`)
console.log(`Base mainnet gas price ${gasPrice} wei`)

const solana = await solanaFinality(3)
console.log('Solana devnet finality (ms):', JSON.stringify(solana.map(({ sig, ...s }) => s)))
fs.writeFileSync(new URL('./out/phase2.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), baseMainnetGasPriceWei: gasPrice.toString(), rows, baseline, solanaDevnetFinality: solana }, null, 2))
console.log('wrote out/phase2.json')
