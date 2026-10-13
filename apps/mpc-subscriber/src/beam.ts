/**
 * Solami Beam: lands finalize_signature over stake-weighted QoS, a QUIC
 * connection straight to the leader, instead of a plain sendTransaction.
 * Opt-in: index.ts loads this file only when SOLAMI_SWQOS_KEY is set.
 *
 * Why it is loaded with a dynamic import: `solami` loads @matrixai/quic, a
 * native module built for glibc only, the moment it is imported. The default
 * path should not depend on it.
 *
 * Not live-tested: no SWQOS key was registered when this was written.
 */
import {
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionError,
} from '@solana/web3.js'
import { builder, buildTipIx, Region } from 'solami'
import bs58 from 'bs58'
import { request } from 'undici'

const DEFAULT_TIP_SOL = 0.0001
// A tip is paid on every finalize. Refusing large values catches a lamports
// figure typed into a SOL field before it drains the payer on mainnet.
const MAX_TIP_SOL = 0.01
const POLL_MS = 500
// Upper bound even if block height cannot be read; the blockhash expiry
// (about 150 blocks, 60-90 s) normally ends the wait first.
const LAND_TIMEOUT_MS = 120_000
const LANDING_API = 'https://api.solami.dev/swqos/tx'

type BeamClient = { beam(tx: VersionedTransaction): Promise<string> }

/** The Beam transaction reached the chain. `err` is null when it succeeded. */
export type BeamLanded = { signature: string; err: TransactionError | null }

export type Beam = {
  tipSol: number
  /** Public identity of the SWQOS key, to match against the Solami dashboard. */
  identity: string
  /** Opens the QUIC connection. A failed attempt is retried on the next call. */
  connect(): Promise<void>
  /**
   * Sends `ix` plus a tip through Beam and waits for it to land. Throws if
   * Beam refused it, the QUIC send failed, or it did not land before its
   * blockhash expired. Returns the on-chain error, if any, once it landed.
   */
  finalize(connection: Connection, payer: Keypair, ix: TransactionInstruction): Promise<BeamLanded>
}

export type BeamOptions = {
  swqosKey: string
  /** Solami API key for the client's RPC half. Beam itself needs only the SWQOS key. */
  rpcToken?: string
  tipSol?: string
  log: (line: string) => void
}

function parseTip(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_TIP_SOL
  const tip = Number(raw)
  if (!Number.isFinite(tip) || tip <= 0 || tip > MAX_TIP_SOL) {
    throw new Error(`SOLAMI_BEAM_TIP_SOL must be a SOL amount above 0 and at most ${MAX_TIP_SOL}, got "${raw}"`)
  }
  return tip
}

/** Never logs the key: only its public half. */
function swqosIdentity(key: string): string {
  let bytes: Uint8Array
  try {
    bytes = bs58.decode(key)
  } catch {
    throw new Error('SOLAMI_SWQOS_KEY is not base58')
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes).publicKey.toBase58()
  if (bytes.length === 32) return Keypair.fromSeed(bytes).publicKey.toBase58()
  throw new Error(`SOLAMI_SWQOS_KEY must decode to a 64-byte keypair or 32-byte seed, got ${bytes.length} bytes`)
}

async function buildClient(swqosKey: string, rpcToken?: string): Promise<BeamClient> {
  // Ams: the Railway services run in Amsterdam, so the Beam entry point is next door.
  if (rpcToken) {
    return builder().withRpc(rpcToken).withSwqos(swqosKey).region(Region.Ams).build()
  }
  return builder().withSwqos(swqosKey).region(Region.Ams).build()
}

/**
 * A signed v0 transaction: `ix`, then the tip. Beam refuses a transaction
 * without a transfer to one of its tip accounts. Both instructions share one
 * transaction, so a failed finalize reverts the tip too.
 */
export function buildBeamTransaction(
  payer: Keypair,
  ix: TransactionInstruction,
  tipSol: number,
  blockhash: string,
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix, buildTipIx(payer.publicKey, tipSol)],
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([payer])
  return tx
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Expired extends Error {}

/**
 * Polls getSignatureStatuses over HTTP. signatureSubscribe is not used: it
 * needs a WebSocket the RPC provider may not serve, which is how the plain
 * path's confirmTransaction can hang.
 */
async function waitForLanding(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<TransactionError | null> {
  const deadline = Date.now() + LAND_TIMEOUT_MS
  for (let i = 0; ; i++) {
    try {
      const { value } = await connection.getSignatureStatuses([signature])
      const st = value[0]
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        return st.err
      }
      if (!st && i % 4 === 3) {
        const height = await connection.getBlockHeight('confirmed')
        if (height > lastValidBlockHeight) {
          // One last look: it may have landed in the final valid block. If it
          // has, keep polling until it is confirmed.
          const last = (await connection.getSignatureStatuses([signature])).value[0]
          if (!last) throw new Expired('blockhash expired before the transaction landed')
        }
      }
    } catch (e) {
      if (e instanceof Expired) throw e
      // A failed status read is not a failed transaction; keep polling.
    }
    if (Date.now() > deadline) throw new Error(`not confirmed after ${LAND_TIMEOUT_MS / 1000}s`)
    await sleep(POLL_MS)
  }
}

/**
 * Logs Solami's own record of how the transaction landed. Informational only:
 * it never throws. The API can lag the chain, so it retries a few times.
 */
async function reportLanding(signature: string, log: (line: string) => void): Promise<void> {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await request(`${LANDING_API}/${signature}`, {
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      })
      if (res.statusCode === 200) {
        const r = (await res.body.json()) as {
          is_landed?: boolean
          landed_via_jito?: boolean
          region?: string
          tip_lamports?: number
        }
        if (r.is_landed || i === 3) {
          log(
            `Beam landing: is_landed=${r.is_landed} region=${r.region} ` +
              `tip=${r.tip_lamports} lamports via_jito=${r.landed_via_jito}`,
          )
          return
        }
      } else {
        await res.body.dump()
        if (i === 3) log(`Beam landing check: HTTP ${res.statusCode}`)
      }
    } catch (e) {
      if (i === 3) log(`Beam landing check failed: ${(e as Error).message}`)
    }
    await sleep(2_000)
  }
}

export function createBeam(opts: BeamOptions): Beam {
  const tipSol = parseTip(opts.tipSol)
  const identity = swqosIdentity(opts.swqosKey)
  let client: Promise<BeamClient> | null = null

  const getClient = () => {
    if (!client) {
      client = buildClient(opts.swqosKey, opts.rpcToken).catch((e) => {
        client = null
        throw e
      })
    }
    return client
  }

  return {
    tipSol,
    identity,
    async connect() {
      await getClient()
    },
    async finalize(connection, payer, ix) {
      const beam = await getClient()
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const tx = buildBeamTransaction(payer, ix, tipSol, blockhash)
      const signature = await beam.beam(tx)
      opts.log(`Beam sent tx=${signature}; polling for confirmation`)
      const err = await waitForLanding(connection, signature, lastValidBlockHeight)
      void reportLanding(signature, opts.log)
      return { signature, err }
    },
  }
}
