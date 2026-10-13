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
import { Connection, PublicKey, Keypair, TransactionInstruction, Transaction } from '@solana/web3.js'
// Derivation now happens inside the mpc-node processes, which re-derive it
// from on-chain state rather than trusting anything this subscriber computes.
import { sha256 } from '@noble/hashes/sha2.js'
import { request } from 'undici'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
// Type-only: beam.ts and grpc-feed.ts load native modules, so they are
// imported dynamically and only when their env vars are set.
import type { Beam } from './beam.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '../../..')
/**
 * `contracts/target/idl/` is a build output and is gitignored, so it does not
 * exist in a container built from the repo. `apps/web/lib/idl/` holds the same
 * files, committed, refreshed from `anchor idl fetch`. Prefer the build output
 * when it is there — it is what a local `anchor build` just produced.
 */
function idlPath(name: string): string {
  const built = resolve(REPO_ROOT, `contracts/target/idl/${name}.json`)
  if (existsSync(built)) return built
  return resolve(REPO_ROOT, `apps/web/lib/idl/${name}.json`)
}

const SODA_IDL_PATH = idlPath('soda')

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
const COORDINATOR_URL = (
  process.env.MPC_COORDINATOR_URL ?? 'http://127.0.0.1:8000'
).replace(/\/+$/, '')
// Bearer token the coordinator requires when it runs on a public host.
const COORDINATOR_TOKEN = process.env.MPC_COORDINATOR_TOKEN ?? ''
const ANCHOR_WALLET =
  process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`

// ---- Opt-in Solami features. All unset = the original devnet behaviour. ----
//
// SODA_PROGRAM_ID           use this soda deployment instead of the IDL's
//                           address (mainnet has its own id; the code and IDL
//                           are otherwise identical).
// SOLAMI_GRPC_URL + _TOKEN  read SigRequested from a Yellowstone gRPC stream
//                           instead of WebSocket logsSubscribe.
// SOLAMI_SWQOS_KEY          land finalize_signature through Solami Beam.
//                           Optional: SOLAMI_BEAM_TIP_SOL (default 0.0001).
const SODA_PROGRAM_ID_OVERRIDE = process.env.SODA_PROGRAM_ID?.trim() || ''
const GRPC_URL = process.env.SOLAMI_GRPC_URL?.trim() || ''
const GRPC_TOKEN = process.env.SOLAMI_GRPC_TOKEN?.trim() || ''
const SWQOS_KEY = process.env.SOLAMI_SWQOS_KEY?.trim() || ''

/**
 * Load the fee payer. `ANCHOR_WALLET_JSON` carries the keypair array itself,
 * for platforms that have no filesystem to put a key file on. `ANCHOR_WALLET`
 * names a file, which is how the CLI and docker compose do it.
 */
function loadPayer(): Keypair {
  const inline = process.env.ANCHOR_WALLET_JSON?.trim()
  if (inline) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(inline)))
  }
  if (!existsSync(ANCHOR_WALLET)) {
    throw new Error(
      `No Solana keypair. Set ANCHOR_WALLET_JSON to the keypair array, ` +
        `or put a keypair file at ${ANCHOR_WALLET}.`,
    )
  }
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(ANCHOR_WALLET, 'utf8'))),
  )
}

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
  /** Signature scheme; 0 = secp256k1 ECDSA. */
  domainId: number
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
    domainId: r.u32(),
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
  // The override feeds everything below: the log filter, the committee PDA and
  // the finalize instruction. Discriminators still come from the IDL, which is
  // valid because the program code is the same on every cluster.
  const sodaProgramId = new PublicKey(SODA_PROGRAM_ID_OVERRIDE || sodaIdl.address)
  const sigRequestedDisc = discFromIdl('SigRequested')

  // SOLANA_WS_URL overrides the WebSocket, because web3.js otherwise derives
  // it from the HTTP host. Some providers serve them on different hosts —
  // Solami's RPC is rpc.solami.dev but its WebSocket is ws.solami.dev/ws/sol —
  // and a wrong guess means SigRequested never arrives.
  const connection = new Connection(SOLANA_RPC, {
    commitment: 'confirmed',
    ...(process.env.SOLANA_WS_URL ? { wsEndpoint: process.env.SOLANA_WS_URL } : {}),
  })
  const payer = loadPayer()

  // Read on-chain group_pk so we can sanity-check incoming foreign_pk_xy.
  const [committeePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('committee')],
    sodaProgramId,
  )
  const committeeAcct = await connection.getAccountInfo(committeePda)
  if (!committeeAcct) throw new Error('Committee PDA missing — run init_committee first')
  // Layout: 8-byte discriminator, u8 bump, 32-byte authority, 33-byte group_pk, u8 signer_count
  const groupPkCompressed = committeeAcct.data.subarray(8 + 1 + 32, 8 + 1 + 32 + 33)

  // Beam is a landing optimisation, so any setup failure (bad config, the
  // native QUIC module missing on this platform) leaves the subscriber on
  // sendRawTransaction instead of stopping it from signing at all.
  let beam: Beam | null = null
  if (SWQOS_KEY) {
    try {
      const { createBeam } = await import('./beam.js')
      beam = createBeam({
        swqosKey: SWQOS_KEY,
        rpcToken: process.env.SOLAMI_API_KEY?.trim() || GRPC_TOKEN || undefined,
        tipSol: process.env.SOLAMI_BEAM_TIP_SOL,
        log,
      })
    } catch (e) {
      log(`${C.red}Beam disabled:${C.reset} ${(e as Error).message}; using sendRawTransaction`)
    }
  }

  const useGrpc = Boolean(GRPC_URL && GRPC_TOKEN)
  if (!useGrpc && (GRPC_URL || GRPC_TOKEN)) {
    log(`${C.yellow}SOLAMI_GRPC_URL and SOLAMI_GRPC_TOKEN must both be set; using WebSocket onLogs${C.reset}`)
  }
  const grpcHost = (() => {
    try {
      return new URL(GRPC_URL).host
    } catch {
      return GRPC_URL.split('?')[0]
    }
  })()

  console.log(`${C.cyan}┏━ SODA MPC subscriber ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${C.reset}`)
  console.log(`${C.cyan}┃${C.reset}  Solana RPC:   ${SOLANA_RPC.split('?')[0]}`)
  console.log(`${C.cyan}┃${C.reset}  Coordinator:  ${COORDINATOR_URL}`)
  console.log(`${C.cyan}┃${C.reset}  Payer:        ${payer.publicKey.toBase58()}`)
  console.log(`${C.cyan}┃${C.reset}  Program:      ${sodaProgramId.toBase58()}${SODA_PROGRAM_ID_OVERRIDE ? ' (SODA_PROGRAM_ID)' : ''}`)
  console.log(`${C.cyan}┃${C.reset}  Committee:    ${committeePda.toBase58()}`)
  console.log(`${C.cyan}┃${C.reset}  group_pk(33): ${Buffer.from(groupPkCompressed).toString('hex')}`)
  console.log(`${C.cyan}┃${C.reset}  Events via:   ${useGrpc ? `Yellowstone gRPC (${grpcHost})` : 'WebSocket logsSubscribe'}`)
  console.log(`${C.cyan}┃${C.reset}  Finalize via: ${beam ? `Solami Beam, tip ${beam.tipSol} SOL, swqos id ${beam.identity}` : 'sendRawTransaction'}`)
  console.log(`${C.cyan}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${C.reset}`)

  // Connect once now rather than on the first request, so a bad key shows up
  // at startup. A failure here is retried on the first finalize.
  if (beam) {
    beam.connect().then(
      () => log('Beam QUIC connection open'),
      (e) => log(`${C.yellow}Beam connect failed:${C.reset} ${(e as Error).message}; will retry on the first finalize`),
    )
  }

  const seenTxs = new Set<string>()

  // Both feeds end here, so they share one decoder and one dedupe set. That
  // set also absorbs the overlap when the gRPC feed replays after a reconnect.
  const processLogs = async (signature: string, logLines: string[]) => {
    if (seenTxs.has(signature)) return
    seenTxs.add(signature)
    for (const line of logLines) {
      if (!line.startsWith('Program data: ')) continue
      const raw = Uint8Array.from(Buffer.from(line.slice('Program data: '.length), 'base64'))
      if (raw.length < 8) continue
      const disc = raw.subarray(0, 8)
      const body = raw.subarray(8)
      if (!bytesEq(disc, sigRequestedDisc)) continue
      try {
        const ev = decodeSigRequested(body)
        await handleSigRequested(connection, payer, sodaProgramId, committeePda, beam, ev)
      } catch (e) {
        log(`${C.red}handler crashed:${C.reset} ${(e as Error).message}`)
      }
    }
  }

  if (useGrpc) {
    const { startGrpcFeed } = await import('./grpc-feed.js')
    startGrpcFeed({
      url: GRPC_URL,
      token: GRPC_TOKEN,
      programId: sodaProgramId.toBase58(),
      onTransaction: (tx) => {
        processLogs(tx.signature, tx.logs).catch((e) =>
          log(`${C.red}log processing failed:${C.reset} ${(e as Error).message}`),
        )
      },
      log,
    })
  } else {
    connection.onLogs(sodaProgramId, async (logs) => {
      if (logs.err) return
      await processLogs(logs.signature, logs.logs)
    })
  }
  log('subscribed; waiting for SigRequested events…')
}

/**
 * soda's AlreadyCompleted is custom error 6000 (0x1770). A Beam transaction
 * has no preflight, so it shows up as an on-chain `{"Custom":6000}` rather
 * than as the preflight message the plain path matches.
 */
function isAlreadyCompleted(text: string): boolean {
  return (
    text.includes('0x1770') ||
    text.includes('"Custom":6000') ||
    text.toLowerCase().includes('alreadycompleted')
  )
}

async function handleSigRequested(
  connection: Connection,
  payer: Keypair,
  sodaProgramId: PublicKey,
  committeePda: PublicKey,
  beam: Beam | null,
  ev: SigRequested,
): Promise<void> {
  log(`${C.yellow}SigRequested${C.reset} sig_request=${ev.sigRequest.toBase58()} requester=${ev.requester.toBase58()}`)

  // The subscriber no longer computes the tweak or forwards a payload. It is
  // an untrusted trigger: it just tells the committee which on-chain request
  // to look at. Each node reads that account from its own RPC and re-derives
  // the payload and tweak itself, so a compromised subscriber cannot obtain a
  // signature over anything the chain did not authorize.
  //
  // This also retires a real bug: the check that used to live here keyed the
  // tweak on `ev.requester` (the signing wallet) while the SDK keys it on the
  // requesting *program* id, so it rejected every legitimate eth_demo request.
  const sigResp = await postJson(`${COORDINATOR_URL}/sign`, {
    sigRequestPubkey: ev.sigRequest.toBase58(),
  })
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
  // Account order must match soda::FinalizeSignature exactly: committee,
  // sig_request, submitter. This list predated `committee` being added and
  // still passed sig_request first, so every submission failed preflight with
  // AccountDiscriminatorMismatch (0xbba) on the committee account — the
  // subscriber produced a valid signature and then threw it away.
  const ix = new TransactionInstruction({
    programId: sodaProgramId,
    keys: [
      { pubkey: committeePda, isSigner: false, isWritable: false },
      { pubkey: ev.sigRequest, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  })

  if (beam) {
    try {
      const landed = await beam.finalize(connection, payer, ix)
      if (!landed.err) {
        log(`${C.green}finalize_signature landed via Beam${C.reset} tx=${landed.signature}`)
        return
      }
      const errText = JSON.stringify(landed.err)
      if (isAlreadyCompleted(errText)) {
        log(`${C.dim}already completed (idempotent)${C.reset}`)
        return
      }
      // It landed but failed, for example a payer too poor for the tip. The
      // plain path below has no tip and runs preflight, so it either succeeds
      // or reports the real finalize error.
      log(`${C.yellow}Beam tx ${landed.signature} failed on-chain (${errText}); falling back to sendRawTransaction${C.reset}`)
    } catch (e) {
      // Refused, unreachable, or not landed in time. Resending is safe: if the
      // Beam transaction lands after all, soda rejects whichever finalize
      // arrives second with AlreadyCompleted.
      log(`${C.yellow}Beam failed (${(e as Error).message}); falling back to sendRawTransaction${C.reset}`)
    }
  }

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
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (COORDINATOR_TOKEN) headers.authorization = `Bearer ${COORDINATOR_TOKEN}`
  const res = await request(url, {
    method: 'POST',
    headers,
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
