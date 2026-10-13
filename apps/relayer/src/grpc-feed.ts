// Yellowstone gRPC event feed — an alternative to `Connection.onLogs`.
//
// Why: a Geyser stream is pushed from the validator plugin itself, and it is
// the only push feed some providers offer (Alchemy's Solana tier has no
// logsSubscribe). Every transaction update carries the full status meta,
// including logMessages, so the relayer's existing "Program data:" decoder
// runs on it unchanged. This file only turns the stream into the same
// { signature, logs, err } shape that onLogs delivers.
//
// The package is imported lazily, on purpose. It loads a native (napi) binding
// at import time, and that binding ships only for linux-x64 (gnu + musl) and
// macOS. A relayer on the WebSocket feed must not fail to start because of a
// dependency it does not use.

import type GrpcClient from "@triton-one/yellowstone-grpc";
import type { SubscribeRequest, SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import { toBase58 } from "@soda-sdk/core";

/** What processLogs consumes: the shape `Connection.onLogs` hands its callback. */
export type LogsEvent = { signature: string; logs: string[]; err: unknown };

export type GrpcFeedOptions = {
  /** e.g. https://grpc.solami.dev:443 */
  url: string;
  /** Sent as the x-token header. Never logged. */
  token: string;
  /** One transaction filter per program; the label is the filter name. */
  programs: { label: string; id: string }[];
  onLogs: (label: string, event: LogsEvent) => void;
  /** "warn" marks a dropped stream or a skipped update. */
  log: (line: string, level: "info" | "warn") => void;
};

// CommitmentLevel.CONFIRMED. The enum is declared in the v9 types but is
// undefined at runtime, so the number is used directly. Confirmed matches the
// commitment the WebSocket feed subscribes at.
const CONFIRMED = 1;

// The server pings us about every 15 s, but an idle subscription (mainnet
// SODA traffic is rare) can still be cut by a proxy in the path. A client ping
// every 10 s keeps it active, and its pong proves the stream is still alive.
const PING_INTERVAL_MS = 10_000;
// With our pings answered and the server's own, a healthy stream is never
// silent for this long. Silence means a dead connection that never errored.
const STALL_TIMEOUT_MS = 45_000;
// Bounds connect + subscribe. Without it an unreachable host can hold the
// first attempt open with no log line, and the relayer looks alive but deaf.
const CONNECT_TIMEOUT_MS = 15_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// A stream that stayed up this long was healthy, so the next drop starts the
// backoff again from 1 s. A stream that flaps keeps backing off.
const STABLE_AFTER_MS = 60_000;

type Stream = Awaited<ReturnType<GrpcClient["subscribe"]>>;

/**
 * The package's ESM build has no `"type": "module"`, so depending on the
 * loader the default export is the Client class itself or a CommonJS
 * namespace whose `.default` is the class. Take whichever is a constructor.
 */
function pickClient(mod: unknown): typeof GrpcClient {
  const m = mod as Record<string, any>;
  for (const c of [m?.default?.default, m?.default, m?.Client]) {
    if (typeof c === "function") return c as typeof GrpcClient;
  }
  throw new Error("@triton-one/yellowstone-grpc: no Client export found");
}

function subscribeRequest(programs: GrpcFeedOptions["programs"]): SubscribeRequest {
  const transactions: SubscribeRequest["transactions"] = {};
  for (const p of programs) {
    // failed:false asks the server for successful transactions only. The
    // WebSocket feed gets failed ones too and processLogs drops them; this
    // just stops them crossing the wire.
    transactions[p.label] = {
      vote: false,
      failed: false,
      accountInclude: [p.id],
      accountExclude: [],
      accountRequired: [],
    };
  }
  return {
    accounts: {},
    slots: {},
    transactions,
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    blockFooter: {},
    commitment: CONFIRMED,
  };
}

// A request with only `ping` set and every filter map empty. Verified against
// Solami: the server answers with a pong and keeps the filters it already has.
function pingRequest(id: number): SubscribeRequest {
  return {
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    blockFooter: {},
    ping: { id },
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Opens the subscription and keeps it open: any error, end, close or stall
 * schedules a reconnect with exponential backoff. Stream problems are logged,
 * never thrown. Only a failure to load the package itself rejects, because
 * that is a deployment problem the operator must see at boot.
 */
export async function startGrpcFeed(opts: GrpcFeedOptions): Promise<void> {
  let Client: typeof GrpcClient;
  try {
    Client = pickClient(await import("@triton-one/yellowstone-grpc"));
  } catch (e) {
    throw new Error(
      `cannot load @triton-one/yellowstone-grpc on ${process.platform}-${process.arch} (${message(e)}). ` +
        `Unset SOLAMI_GRPC_URL to use the WebSocket feed instead.`,
    );
  }

  const request = subscribeRequest(opts.programs);
  // Each connection attempt gets a number. Events from a stream whose number
  // is no longer current are ignored, so one failure (which can fire error,
  // end and close together) triggers exactly one reconnect.
  let generation = 0;
  let attempt = 0;
  let backoff = BACKOFF_START_MS;

  const scheduleReconnect = (reason: string) => {
    attempt++;
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    opts.log(`gRPC stream ${reason} — reconnecting in ${delay / 1000}s (attempt ${attempt})`, "warn");
    setTimeout(() => void connect(), delay);
  };

  const connect = async () => {
    const gen = ++generation;
    let stream: Stream;
    // A new client per attempt: after a transport error the old channel may
    // be the thing that is broken.
    const opening = (async () => {
      const client = new Client(opts.url, opts.token, undefined);
      await client.connect();
      return client.subscribe();
    })();
    try {
      stream = await withTimeout(opening, CONNECT_TIMEOUT_MS, "connect");
    } catch (e) {
      // If the timed-out attempt opens later, close it: a retry is already
      // on its way and two live streams would deliver every event twice.
      opening.then((late) => late.destroy(), () => {});
      if (gen === generation) {
        generation++;
        scheduleReconnect(`connect failed: ${message(e)}`);
      }
      return;
    }

    const openedAt = Date.now();
    let lastMessageAt = openedAt;
    let announced = false;
    let pingId = 0;

    const drop = (reason: string) => {
      if (gen !== generation) return;
      generation++;
      clearInterval(timer);
      try {
        stream.destroy();
      } catch {
        // Already torn down. Nothing to clean up.
      }
      if (Date.now() - openedAt >= STABLE_AFTER_MS) backoff = BACKOFF_START_MS;
      scheduleReconnect(reason);
    };

    const timer = setInterval(() => {
      if (Date.now() - lastMessageAt > STALL_TIMEOUT_MS) {
        drop(`silent for ${STALL_TIMEOUT_MS / 1000}s`);
        return;
      }
      if (stream.writable) {
        stream.write(pingRequest(++pingId), (err?: Error | null) => {
          if (err) drop(`ping failed: ${err.message}`);
        });
      }
    }, PING_INTERVAL_MS);

    stream.on("data", (update: SubscribeUpdate) => {
      if (gen !== generation) return;
      lastMessageAt = Date.now();
      if (!announced) {
        // The server sends a ping right after subscribing, so the first
        // message of any kind means the filters were accepted.
        announced = true;
        opts.log(attempt === 0 ? `gRPC stream subscribed` : `gRPC stream re-subscribed after ${attempt} attempt(s)`, "info");
        attempt = 0;
      }
      const info = update.transaction?.transaction;
      const meta = info?.meta;
      if (!info || !meta) return; // ping, pong
      // A throw here would destroy the stream and cost a reconnect, so one
      // bad update is logged and skipped instead.
      try {
        opts.onLogs(update.filters.join("+"), {
          signature: toBase58(info.signature),
          logs: meta.logMessagesNone ? [] : meta.logMessages,
          // Present only on a failed transaction, like onLogs' `err`.
          err: meta.err ?? null,
        });
      } catch (e) {
        opts.log(`gRPC update skipped: ${message(e)}`, "warn");
      }
    });
    stream.on("error", (e: Error) => drop(`error: ${e.message}`));
    stream.on("end", () => drop("ended by the server"));
    stream.on("close", () => drop("closed"));

    stream.write(request, (err?: Error | null) => {
      if (err) drop(`subscribe failed: ${err.message}`);
    });
  };

  await connect();
}
