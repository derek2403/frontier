import type { TPCEcdsaSign } from '@safeheron/two-party-ecdsa-js'

/**
 * In-memory map of active signing sessions. A session is created by
 * /sign/init and torn down by /sign/finalize (P1) or after step2 returns
 * the last message (P2). We TTL-expire abandoned sessions so a misbehaving
 * coordinator can't leak memory on us.
 */

type AnySignContext =
  | InstanceType<typeof TPCEcdsaSign.P1Context>
  | InstanceType<typeof TPCEcdsaSign.P2Context>

type Session = {
  context: AnySignContext
  /**
   * The SODA tweak this node derived from the chain for this request. It is
   * applied to the message later in the protocol, once `r` is known — see
   * `tweak.ts`. Kept per session because each node derives it independently
   * at authorization time and must not re-read it from a caller.
   */
  tweakHex: string
  createdAt: number
}

const SESSION_TTL_MS = 5 * 60 * 1000 // 5 minutes
const sessions = new Map<string, Session>()

export function setSession(
  id: string,
  context: AnySignContext,
  tweakHex: string,
): void {
  sessions.set(id, { context, tweakHex, createdAt: Date.now() })
}

export function getSession(id: string): Session | undefined {
  const s = sessions.get(id)
  if (!s) return undefined
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(id)
    return undefined
  }
  return s
}

export function dropSession(id: string): void {
  sessions.delete(id)
}

// Periodic GC of stale sessions.
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id)
  }
}, 60_000).unref()
