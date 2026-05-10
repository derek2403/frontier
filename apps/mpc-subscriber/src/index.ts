/**
 * SODA MPC subscriber.
 *
 * Subscribes to SigRequested events on Solana, drives the MPC coordinator
 * to produce a real ECDSA signature via 2-of-2 Lindell '17, and submits
 * `soda::finalize_signature(signature, recovery_id)` so the on-chain
 * `secp256k1_recover` can verify the result.
 *
 * This replaces the v0 single-key Rust signer (`contracts/signer/`).
 *
 * Mirrors apps/relayer/src/index.ts in style: hand-rolled Anchor-style
 * event decoding (Anchor 0.32.1's addEventListener doesn't dispatch on
 * IDLs whose event field types are in `types`).
 */
import { Connection, PublicKey, Keypair, TransactionInstruction, Transaction, SystemProgram } from '@solana/web3.js'
import { computeTweak, deriveForeignPk } from '@soda-sdk/core'
import { sha256 } from '@noble/hashes/sha2.js'
import { request } from 'undici'
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
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim()
    if (!process.env[k]) process.env[k] = v
  }
})()

const SOLANA_RPC =
  process.env.SOLANA_RPC_URL ??
  process.env.SOLANA_DEVNET_RPC_URL ??
  'http://127.0.0.1:8899'
const COORDINATOR_URL =
  process.env.MPC_COORDINATOR_URL ?? 'http://127.0.0.1:8000'
const ANCHOR_WALLET =
  process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`

// ---- borsh reader for SigRequested ----

class Reader {
  off = 0
  constructor(public buf: Uint8Array) {}
  pubkey(): PublicKey {
    const p = new PublicKey(this.buf.slice(this.off, this.off + 32))
    this.off += 32
    return p
  }
  bytes(n: number): Uint8Array {
    const out = this.buf.slice(this.off, this.off + n)
    this.off += n
    return out
  }
  u32(): number {
    const v =
      this.buf[this.off] |
      (this.buf[this.off + 1] << 8) |
      (this.buf[this.off + 2] << 16) |
      (this.buf[this.off + 3] << 24)
    this.off += 4
    return v >>> 0
  }
  vecU8(): Uint8Array {
    return this.bytes(this.u32())
  }
}

type SigRequested = {
  sigRequest: PublicKey
  requester: PublicKey
  foreignPkXY: Uint8Array
  payload: Uint8Array
  chainTag: Uint8Array
  derivationSeeds: Uint8Array
}

function decodeSigRequested(body: Uint8Array): SigRequested {
  const r = new Reader(body)
  return {
    sigRequest: r.pubkey(),
    requester: r.pubkey(),
    foreignPkXY: r.bytes(64),
    payload: r.bytes(32),
    chainTag: r.bytes(32),
    derivationSeeds: r.vecU8(),
  }
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function discFromIdl(name: string): Uint8Array {
  const idl = JSON.parse(readFileSync(SODA_IDL_PATH, 'utf8'))
  const ev = idl.events.find((e: { name: string }) => e.name === name)
  if (!ev) throw new Error(`event ${name} missing in IDL`)
  return Uint8Array.from(ev.discriminator)
}

const FINALIZE_DISC = sha256(
  new TextEncoder().encode('global:finalize_signature'),
).slice(0, 8)

// ---- Solana coloured logging ----

const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' }
const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', '')
const log = (line: string) => console.log(`${C.dim}[${ts()}]${C.reset} ${line}`)

async function main() {
  const sodaIdl = JSON.parse(readFileSync(SODA_IDL_PATH, 'utf8'))
  const sodaProgramId = new PublicKey(sodaIdl.address)
  const sigRequestedDisc = discFromIdl('SigRequested')

  const connection = new Connection(SOLANA_RPC, 'confirmed')
  const payerSecret = new Uint8Array(JSON.parse(readFileSync(ANCHOR_WALLET, 'utf8')))
  const payer = Keypair.fromSecretKey(payerSecret)

  // Read on-chain group_pk so we can sanity-check incoming foreign_pk_xy.
  const [committeePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('committee')],
    sodaProgramId,
  )
  const committeeAcct = await connection.getAccountInfo(committeePda)
  if (!committeeAcct) throw new Error('Committee PDA missing — run init_committee first')
  // Layout: 8-byte discriminator, u8 bump, 32-byte authority, 33-byte group_pk, u8 signer_count
  const groupPkCompressed = committeeAcct.data.subarray(8 + 1 + 32, 8 + 1 + 32 + 33)

  console.log(`${C.cyan}┏━ SODA MPC subscriber ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${C.reset}`)
  console.log(`${C.cyan}┃${C.reset}  Solana RPC:   ${SOLANA_RPC.split('?')[0]}`)
  console.log(`${C.cyan}┃${C.reset}  Coordinator:  ${COORDINATOR_URL}`)
  console.log(`${C.cyan}┃${C.reset}  Payer:        ${payer.publicKey.toBase58()}`)
  console.log(`${C.cyan}┃${C.reset}  Committee:    ${committeePda.toBase58()}`)
  console.log(`${C.cyan}┃${C.reset}  group_pk(33): ${Buffer.from(groupPkCompressed).toString('hex')}`)
  console.log(`${C.cyan}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${C.reset}`)

  const seenTxs = new Set<string>()

  connection.onLogs(sodaProgramId, async (logs) => {
    if (logs.err) return
    if (seenTxs.has(logs.signature)) return
    seenTxs.add(logs.signature)
    for (const line of logs.logs) {
      if (!line.startsWith('Program data: ')) continue
      const raw = Uint8Array.from(Buffer.from(line.slice('Program data: '.length), 'base64'))
      if (raw.length < 8) continue
      const disc = raw.subarray(0, 8)
      const body = raw.subarray(8)
      if (!bytesEq(disc, sigRequestedDisc)) continue
      try {
        const ev = decodeSigRequested(body)
        await handleSigRequested(connection, payer, sodaProgramId, groupPkCompressed, ev)
      } catch (e) {
        log(`${C.red}handler crashed:${C.reset} ${(e as Error).message}`)
      }
    }
  })
  log('subscribed; waiting for SigRequested events…')
}

async function handleSigRequested(
  connection: Connection,
  payer: Keypair,
  sodaProgramId: PublicKey,
  groupPkCompressed: Uint8Array,
  ev: SigRequested,
): Promise<void> {
  log(`${C.yellow}SigRequested${C.reset} sig_request=${ev.sigRequest.toBase58()} requester=${ev.requester.toBase58()}`)

  // Compute the SODA tweak from the event fields. requester + seeds + chain_tag
  // are exactly what `soda-sdk`'s `computeTweak` consumes.
  const tweak = computeTweak(
    ev.requester.toBytes(),
    ev.derivationSeeds,
    ev.chainTag,
  )

  // Sanity-check: derived foreign_pk must equal the one stored in the request.
  const expectedForeignPk = deriveForeignPk(groupPkCompressed, tweak)
  // foreignPk is 65 bytes (0x04 || X || Y); the on-chain copy is 64 bytes (X || Y).
  const expectedXY = expectedForeignPk.subarray(1)
  if (!bytesEq(expectedXY, ev.foreignPkXY)) {
    log(`${C.red}foreign_pk mismatch — refusing to sign${C.reset}`)
    return
  }

  // Drive the MPC coordinator.
  const tweakHex = Buffer.from(tweak).toString('hex')
  const payloadHex = Buffer.from(ev.payload).toString('hex')
  const sigResp = await postJson(`${COORDINATOR_URL}/sign`, { payloadHex, tweakHex })
  if (!sigResp.r || !sigResp.s || sigResp.v == null) {
    log(`${C.red}coordinator returned no sig:${C.reset} ${JSON.stringify(sigResp)}`)
    return
  }
  log(`MPC sig produced  r=${sigResp.r.slice(0, 12)}… s=${sigResp.s.slice(0, 12)}… v=${sigResp.v}`)

  const signature = Buffer.concat([
    Buffer.from(sigResp.r, 'hex'),
    Buffer.from(sigResp.s, 'hex'),
  ])
  if (signature.length !== 64) {
    log(`${C.red}bad signature length: ${signature.length}${C.reset}`)
    return
  }

  // Build finalize_signature ix. Anchor instruction layout: 8-byte global
  // discriminator + borsh-encoded args. Args here are [u8;64] then u8.
  const data = Buffer.concat([Buffer.from(FINALIZE_DISC), signature, Buffer.from([sigResp.v])])
  const ix = new TransactionInstruction({
    programId: sodaProgramId,
    keys: [
      { pubkey: ev.sigRequest, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })

  try {
    const tx = new Transaction().add(ix)
    tx.feePayer = payer.publicKey
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.sign(payer)
    const txSig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    })
    await connection.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, 'confirmed')
    log(`${C.green}finalize_signature submitted${C.reset} tx=${txSig}`)
  } catch (e) {
    const msg = (e as Error).message ?? ''
    if (msg.includes('0x1770') || msg.toLowerCase().includes('alreadycompleted')) {
      log(`${C.dim}already completed (idempotent)${C.reset}`)
    } else {
      throw e
    }
  }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.statusCode >= 400) {
    const text = await res.body.text()
    throw new Error(`POST ${url} failed: ${res.statusCode} ${text}`)
  }
  return res.body.json()
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
