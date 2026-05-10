/**
 * Migrate the on-chain `Committee` PDA from the v0 single-key `group_pk` to
 * the v0.5 MPC joint `group_pk` produced by DKG.
 *
 * Usage:
 *   pnpm --filter mpc-node exec tsx scripts/update-committee.ts \
 *     apps/mpc-node/shares/share-p1.json
 *
 * Reads `groupPkXY` from the share file (P1 or P2 — both contain the same
 * joint public key) and submits `soda::update_committee(new_group_pk,
 * signer_count=2)` from the wallet at $ANCHOR_WALLET.
 *
 * Only the original `init_committee` authority can call this — the on-chain
 * ix uses `has_one = authority`.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '../../..')
const SODA_IDL_PATH = resolve(REPO_ROOT, 'contracts/target/idl/soda.json')

;(() => {
  const envPath = resolve(REPO_ROOT, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    process.env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim()
  }
})()

const SOLANA_RPC =
  process.env.SOLANA_RPC_URL ??
  process.env.SOLANA_DEVNET_RPC_URL ??
  'http://127.0.0.1:8899'
const ANCHOR_WALLET =
  process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`

const sharePath = process.argv[2]
if (!sharePath) {
  console.error(
    'Usage: tsx scripts/update-committee.ts <share-file>\n' +
      '  e.g.  tsx scripts/update-committee.ts apps/mpc-node/shares/share-p1.json',
  )
  process.exit(2)
}

const share = JSON.parse(readFileSync(sharePath, 'utf8')) as {
  role: string
  groupPkXY: { x: string; y: string }
}

// Compress (X, Y) -> 33 bytes (0x02 if y even, 0x03 if y odd, then X).
const yLastByte = parseInt(share.groupPkXY.y.slice(-2), 16)
const compressedPrefix = (yLastByte & 1) === 0 ? 0x02 : 0x03
const groupPkCompressed = new Uint8Array(33)
groupPkCompressed[0] = compressedPrefix
groupPkCompressed.set(Buffer.from(share.groupPkXY.x, 'hex'), 1)

const sodaIdl = JSON.parse(readFileSync(SODA_IDL_PATH, 'utf8'))
const sodaProgramId = new PublicKey(sodaIdl.address)

const connection = new Connection(SOLANA_RPC, 'confirmed')
const payerSecret = new Uint8Array(JSON.parse(readFileSync(ANCHOR_WALLET, 'utf8')))
const payer = Keypair.fromSecretKey(payerSecret)

const [committeePda] = PublicKey.findProgramAddressSync(
  [Buffer.from('committee')],
  sodaProgramId,
)

const updateDisc = sha256(
  new TextEncoder().encode('global:update_committee'),
).slice(0, 8)

// Args: [u8;33] new_group_pk + u8 new_signer_count = 34 bytes total.
const SIGNER_COUNT = 2
const data = Buffer.concat([
  Buffer.from(updateDisc),
  Buffer.from(groupPkCompressed),
  Buffer.from([SIGNER_COUNT]),
])

const ix = new TransactionInstruction({
  programId: sodaProgramId,
  keys: [
    { pubkey: committeePda, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
  ],
  data,
})

const tx = new Transaction().add(ix)
tx.feePayer = payer.publicKey
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
tx.recentBlockhash = blockhash
tx.sign(payer)

console.log('Submitting update_committee...')
console.log(`  Solana RPC:   ${SOLANA_RPC.split('?')[0]}`)
console.log(`  Authority:    ${payer.publicKey.toBase58()}`)
console.log(`  Committee:    ${committeePda.toBase58()}`)
console.log(`  new group_pk: ${Buffer.from(groupPkCompressed).toString('hex')}`)
console.log(`  signer_count: ${SIGNER_COUNT}`)

const sig = await connection.sendRawTransaction(tx.serialize())
await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
console.log(`\nDone. Tx: ${sig}`)
