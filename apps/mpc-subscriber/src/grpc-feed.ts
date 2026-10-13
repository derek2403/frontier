/**
 * Yellowstone gRPC feed of soda transactions. Opt-in: index.ts loads this
 * file only when SOLAMI_GRPC_URL and SOLAMI_GRPC_TOKEN are both set.
 *
 * It delivers (signature, logs) for each successful transaction that touches
 * the program. Decoding SigRequested and acting on it stay in index.ts, shared
 * with the WebSocket (onLogs) path.
 *
 * Why it is loaded with a dynamic import: the Yellowstone v9 client is a
 * native module. The default WebSocket path should never load it.
 *
 * Shapes below were read off live Solami updates (2026-10-13), not guessed:
 * the signature is 64 raw bytes, the logs are `meta.logMessages`, `meta.err`
 * is undefined on success, the server pings every 10 s, a client ping gets a
 * pong and leaves the filters alone, and a `fromSlot` the server no longer
 * holds closes the stream after a ping but before any slot or transaction.
 */
import YellowstoneClient, {
  type SubscribeRequest,
  type SubscribeUpdate,
} from '@triton-one/yellowstone-grpc'
import bs58 from 'bs58'

// tsx loads the package's CommonJS build, so the default import is the whole
// exports object with the class on `.default`. Plain Node ESM gives the class
// itself. Accept both; without this, tsx fails with "Client is not a constructor".
const Client: typeof YellowstoneClient =
  (YellowstoneClient as unknown as { default?: typeof YellowstoneClient }).default ??
  YellowstoneClient

export type GrpcTx = { signature: string; slot: string; logs: string[] }

export type GrpcFeedOptions = {
  url: string
  token: string
  programId: string
  onTransaction: (tx: GrpcTx) => void
  log: (line: string) => void
}

// 1 = confirmed (0 processed, 2 finalized). The CommitmentLevel enum is not
// usable at runtime in v9, so the number is written directly. Confirmed is
// what onLogs uses too.
const CONFIRMED = 1
// The server pings every 10 s; pinging back at the same rate keeps proxies
// from closing a stream that carries no soda traffic for hours.
const PING_INTERVAL_MS = 10_000
// Confirmed slot updates arrive several times a second, so 30 s of silence
// means the stream is dead even if no error was raised.
const IDLE_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 15_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
// Only a stream that stayed up this long resets the backoff, so a server that
// accepts and then drops at once is not hammered every second.
const HEALTHY_AFTER_MS = 60_000

const EMPTY_REQUEST: SubscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {},
  transactionsStatus: {},
  blocks: {},
  blocksMeta: {},
  entry: {},
  blockFooter: {},
  accountsDataSlice: [],
}

function subscribeRequest(programId: string, fromSlot?: string): SubscribeRequest {
  return {
    ...EMPTY_REQUEST,
    transactions: {
      soda: {
        vote: false,
        failed: false,
        accountInclude: [programId],
        accountExclude: [],
        accountRequired: [],
      },
    },
    // Slot updates are the heartbeat and the resume point. A quiet program
    // sends no transactions, but the chain always moves.
    slots: { slot: { filterByCommitment: true } },
    commitment: CONFIRMED,
    ...(fromSlot ? { fromSlot } : {}),
  }
}

type StreamOutcome = {
  /** The client connected and opened a stream. */
  connected: boolean
  /** At least one slot or transaction update came back. */
  gotData: boolean
  reason: string
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Runs one stream until it fails. Never rejects. */
async function streamOnce(
  opts: GrpcFeedOptions,
  fromSlot: string | undefined,
  onLive: () => void,
  onSlot: (slot: string) => void,
): Promise<StreamOutcome> {
  type Stream = Awaited<ReturnType<YellowstoneClient['subscribe']>>
  let stream: Stream
  // A fresh client per attempt: after a failure the old channel may be the
  // broken part. The timeout keeps a hung connect from stalling the loop.
  const opening = (async () => {
    const client = new Client(opts.url, opts.token, undefined)
    await client.connect()
    return client.subscribe()
  })()
  try {
    stream = await new Promise<Stream>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s`))
        // If it opens after all, close it rather than leave it running.
        opening.then((s) => s.destroy(), () => {})
      }, CONNECT_TIMEOUT_MS)
      opening.then(
        (s) => {
          clearTimeout(t)
          resolve(s)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  } catch (e) {
    return { connected: false, gotData: false, reason: `connect: ${errText(e)}` }
  }

  return new Promise<StreamOutcome>((resolve) => {
    let gotData = false
    let done = false
    let lastUpdateAt = Date.now()
    let pingId = 0

    const finish = (reason: string) => {
      if (done) return
      done = true
      clearInterval(timer)
      stream.destroy()
      resolve({ connected: true, gotData, reason })
    }

    const timer = setInterval(() => {
      if (Date.now() - lastUpdateAt > IDLE_TIMEOUT_MS) {
        finish(`no update for ${IDLE_TIMEOUT_MS / 1000}s`)
        return
      }
      stream.write({ ...EMPTY_REQUEST, ping: { id: ++pingId } }, (err?: Error | null) => {
        if (err) finish(`ping: ${err.message}`)
      })
    }, PING_INTERVAL_MS)

    stream.on('data', (u: SubscribeUpdate) => {
      lastUpdateAt = Date.now()
      // The server pings as its first message, even on a stream it is about
      // to reject (a stale fromSlot does exactly that). Pings and pongs prove
      // only that the connection is up, so only slots and transactions count.
      if (!u.slot && !u.transaction) return
      if (!gotData) {
        gotData = true
        onLive()
      }
      if (u.slot) {
        onSlot(u.slot.slot)
        return
      }
      const info = u.transaction?.transaction
      if (!u.transaction || !info?.meta) return
      // `failed: false` already filters these on the server; checked again so
      // a server that ignores the flag cannot feed a reverted request through.
      if (info.meta.err) return
      if (info.meta.logMessagesNone) return
      // A throw here would surface as a stream error and force a reconnect,
      // so one bad transaction is logged and skipped instead.
      try {
        opts.onTransaction({
          signature: bs58.encode(info.signature),
          slot: u.transaction.slot,
          logs: info.meta.logMessages,
        })
      } catch (e) {
        opts.log(`gRPC transaction skipped: ${errText(e)}`)
      }
    })
    stream.on('error', (e: Error) => finish(e.message))
    stream.on('end', () => finish('stream ended'))
    stream.on('close', () => finish('stream closed'))

    stream.write(subscribeRequest(opts.programId, fromSlot), (err?: Error | null) => {
      if (err) finish(`subscribe: ${err.message}`)
    })
  })
}

/**
 * Subscribes and keeps the subscription alive for the life of the process.
 * Reconnects with exponential backoff. After a drop it resumes from the last
 * confirmed slot it saw, so a SigRequested that landed during the gap is
 * replayed rather than lost. The caller's dedupe absorbs the overlap.
 */
export function startGrpcFeed(opts: GrpcFeedOptions): void {
  void (async () => {
    let lastSlot: string | undefined
    let replay = true
    let attempt = 0
    const host = (() => {
      try {
        return new URL(opts.url).host
      } catch {
        return 'gRPC endpoint'
      }
    })()

    for (;;) {
      const fromSlot = replay ? lastSlot : undefined
      const startedAt = Date.now()
      const outcome = await streamOnce(
        opts,
        fromSlot,
        () => opts.log(`gRPC stream live on ${host}${fromSlot ? ` (resumed from slot ${fromSlot})` : ''}`),
        (slot) => {
          if (!lastSlot || BigInt(slot) > BigInt(lastSlot)) lastSlot = slot
        },
      )

      // A fromSlot the server no longer keeps fails before any slot arrives. Go live
      // on the next attempt instead of retrying the same stale slot forever.
      // That gap is lost, as it would be on the WebSocket path.
      if (fromSlot && outcome.connected && !outcome.gotData) {
        replay = false
        opts.log(`gRPC replay from slot ${fromSlot} was refused; reconnecting live, events in the gap are not replayed`)
      } else {
        replay = true
      }

      if (Date.now() - startedAt >= HEALTHY_AFTER_MS) attempt = 0
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt)
      attempt++
      opts.log(`gRPC stream down (${outcome.reason}); reconnecting in ${delay / 1000}s`)
      await sleep(delay)
    }
  })()
}
