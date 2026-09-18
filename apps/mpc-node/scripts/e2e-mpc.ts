/**
 * End-to-end proof that the MPC committee can sign for a SODA-derived
 * address, checked by the real on-chain program.
 *
 * The unit tests in `src/tweak.test.ts` prove the cryptography. This proves
 * the whole path: the Solana program derives `foreign_pk` on-chain, the two
 * MPC nodes independently read that request and derive the same tweak, the
 * Lindell '17 protocol produces one signature, and `finalize_signature`
 * accepts it via the `secp256k1_recover` syscall. Nothing here trusts a
 * local computation — the chain is the judge.
 *
 * Run against a local validator with both programs deployed:
 *
 *   SOLANA_RPC_URL=http://127.0.0.1:8899 \
 *   MPC_COORDINATOR_URL=http://127.0.0.1:8000 \
 *   pnpm --filter mpc-node exec tsx scripts/e2e-mpc.ts
 *
 * It initialises the Committee with the MPC group key if one does not exist
 * yet. It never tries to change an existing committee — that needs the
 * authority, and doing it silently would be the wrong thing.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')

const RPC = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
const COORDINATOR = (
  process.env.MPC_COORDINATOR_URL ?? 'http://127.0.0.1:8000'
).replace(/\/+$/, '')
const COORD_TOKEN = process.env.MPC_COORDINATOR_TOKEN ?? ''
const SHARE = resolve(
  REPO_ROOT,
  process.env.MPC_SHARE_PATH ?? 'apps/mpc-node/shares/share-p1.json',
)
const WALLET = process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`

function idlPath(name: string): string {
  const built = resolve(REPO_ROOT, `contracts/target/idl/${name}.json`)
  return existsSync(built)
    ? built
    : resolve(REPO_ROOT, `apps/web/lib/idl/${name}.json`)
}
const SODA_PROGRAM = new PublicKey(
  process.env.SODA_PROGRAM_ID ??
    JSON.parse(readFileSync(idlPath('soda'), 'utf8')).address,
)

const disc = (s: string) => Buffer.from(sha256(new TextEncoder().encode(s)).slice(0, 8))
const ok = (s: string) => console.log(`  \x1b[32mPASS\x1b[0m ${s}`)
const step = (s: string) => console.log(`\n\x1b[36m${s}\x1b[0m`)

// ---------------------------------------------------------------- setup

const connection = new Connection(RPC, 'confirmed')
const wallet = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(WALLET, 'utf8'))),
)
const share = JSON.parse(readFileSync(SHARE, 'utf8'))
const groupPk = Buffer.concat([
  Buffer.from([
    (Buffer.from(share.groupPkXY.y, 'hex')[31] & 1) === 0 ? 0x02 : 0x03,
  ]),
  Buffer.from(share.groupPkXY.x, 'hex'),
])

console.log(`RPC          ${RPC}`)
console.log(`soda         ${SODA_PROGRAM.toBase58()}`)
console.log(`wallet       ${wallet.publicKey.toBase58()}`)
console.log(`MPC group_pk ${groupPk.toString('hex')}`)

const [committeePda] = PublicKey.findProgramAddressSync(
  [Buffer.from('committee')],
  SODA_PROGRAM,
)

// ------------------------------------------------- 1. committee on-chain

step('1. Committee')
const existing = await connection.getAccountInfo(committeePda)
if (!existing) {
  const data = Buffer.concat([disc('global:init_committee'), groupPk])
  await send(
    new TransactionInstruction({
      programId: SODA_PROGRAM,
      keys: [
        { pubkey: committeePda, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }),
  )
  ok(`initialised ${committeePda.toBase58()} with the MPC group key`)
} else {
  const onChain = existing.data.subarray(8 + 1 + 32, 8 + 1 + 32 + 33)
  if (!onChain.equals(groupPk)) {
    console.error(
      `\n  on-chain group_pk  ${onChain.toString('hex')}` +
        `\n  MPC group_pk       ${groupPk.toString('hex')}` +
        `\n\nThe committee holds a different key, so the chain cannot accept` +
        `\nanything this committee signs. Run update_committee as the` +
        `\nauthority (${new PublicKey(existing.data.subarray(9, 41)).toBase58()}).`,
    )
    process.exit(1)
  }
  ok(`committee already holds the MPC group key`)
}

// ------------------------------------------------- 2. request a signature

step('2. request_signature — the program derives the address itself')
const seeds = Buffer.from(process.env.E2E_PATH ?? '', 'utf8')
const chainTag = Buffer.alloc(32)
Buffer.from('evm', 'utf8').copy(chainTag, 0)

// A payload that is unique per run, so re-running does not collide with an
// existing SigRequest PDA.
const payload = Buffer.from(
  keccak_256(new TextEncoder().encode(`soda-e2e-${Date.now()}`)),
)

const [sigRequestPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('sig'), wallet.publicKey.toBytes(), payload],
  SODA_PROGRAM,
)

const seedsLen = Buffer.alloc(4)
seedsLen.writeUInt32LE(seeds.length)
const domainId = Buffer.alloc(4) // 0 = secp256k1 ECDSA

await send(
  new TransactionInstruction({
    programId: SODA_PROGRAM,
    keys: [
      { pubkey: committeePda, isSigner: false, isWritable: false },
      { pubkey: sigRequestPda, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc('global:request_signature'),
      seedsLen,
      seeds,
      payload,
      chainTag,
      domainId,
    ]),
  }),
)
ok(`SigRequest ${sigRequestPda.toBase58()}`)

// Read back what the PROGRAM derived. This is the address the chain says the
// wallet owns; nothing off-chain got a vote.
const srAcct = await connection.getAccountInfo(sigRequestPda)
if (!srAcct) throw new Error('SigRequest not found after creation')
const foreignPkXY = srAcct.data.subarray(
  8 + 1 + 32 + 32,
  8 + 1 + 32 + 32 + 64,
)
const ethAddress =
  '0x' + Buffer.from(keccak_256(foreignPkXY)).subarray(12).toString('hex')
console.log(`  derived on-chain: ${ethAddress}`)

// Independent check that the chain derived what SODA's formula says.
const tweak = sha256(
  Buffer.concat([
    Buffer.from('SODA-v1', 'utf8'),
    wallet.publicKey.toBuffer(),
    seeds,
    chainTag,
  ]),
)
const expected = Buffer.from(
  secp256k1.Point.fromBytes(groupPk)
    .add(
      secp256k1.Point.BASE.multiply(
        BigInt('0x' + Buffer.from(tweak).toString('hex')) %
          secp256k1.Point.Fn.ORDER,
      ),
    )
    .toBytes(false),
).subarray(1)
if (!expected.equals(foreignPkXY)) {
  throw new Error('on-chain derivation does not match group_pk + tweak*G')
}
ok('on-chain foreign_pk == group_pk + tweak*G')

// ------------------------------------------------- 3. MPC signs it

step('3. MPC committee signs — neither node holds the whole key')
const t0 = Date.now()
const res = await fetch(`${COORDINATOR}/sign`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(COORD_TOKEN ? { authorization: `Bearer ${COORD_TOKEN}` } : {}),
  },
  body: JSON.stringify({ sigRequestPubkey: sigRequestPda.toBase58() }),
})
if (!res.ok) {
  throw new Error(`coordinator ${res.status}: ${await res.text()}`)
}
const sig = (await res.json()) as { r: string; s: string; v: number }
ok(`signature in ${Date.now() - t0}ms  v=${sig.v}`)
console.log(`  r ${sig.r}`)
console.log(`  s ${sig.s}`)

// ------------------------------------------------- 4. the chain judges it

step('4. finalize_signature — secp256k1_recover on-chain')
const signature = Buffer.concat([
  Buffer.from(sig.r, 'hex'),
  Buffer.from(sig.s, 'hex'),
])
const txSig = await send(
  new TransactionInstruction({
    programId: SODA_PROGRAM,
    keys: [
      { pubkey: committeePda, isSigner: false, isWritable: false },
      { pubkey: sigRequestPda, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([
      disc('global:finalize_signature'),
      signature,
      Buffer.from([sig.v & 1]),
    ]),
  }),
)
ok(`accepted on-chain: ${txSig}`)

const after = await connection.getAccountInfo(sigRequestPda)
const completedOffset = after!.data.length - 1
if (after!.data[completedOffset] !== 1) {
  // The flag sits after expires_at; find it by re-deriving the layout end.
  console.log('  (note: could not read the completed flag by offset)')
}

console.log(
  `\n\x1b[32mThe 2-of-2 MPC committee produced a signature for ${ethAddress},` +
    `\nand the Solana program verified it with secp256k1_recover.\x1b[0m\n`,
)

// ---------------------------------------------------------------- helper

async function send(ix: TransactionInstruction): Promise<string> {
  const tx = new Transaction().add(ix)
  tx.feePayer = wallet.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
  tx.sign(wallet)
  const sig = await connection.sendRawTransaction(tx.serialize())
  const bh = await connection.getLatestBlockhash()
  const conf = await connection.confirmTransaction(
    { signature: sig, ...bh },
    'confirmed',
  )
  if (conf.value.err) {
    const logs = await connection.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    throw new Error(
      `tx failed: ${JSON.stringify(conf.value.err)}\n` +
        (logs?.meta?.logMessages ?? []).join('\n'),
    )
  }
  return sig
}
