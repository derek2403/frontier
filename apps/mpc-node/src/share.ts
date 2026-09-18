import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export type Role = 'p1' | 'p2'

/**
 * The on-disk share file format. We persist the JSON the Safeheron lib gives
 * us via `keyShare.toJsonObject()`, plus the role, plus the group public key
 * X / Y bytes (so the coordinator can read them without parsing curve points).
 */
export type ShareFile = {
  role: Role
  groupPkXY: { x: string; y: string }
  share: object
}

/**
 * Load this node's share.
 *
 * Two sources, in order:
 *
 *  1. `MPC_SHARE_B64` — the share JSON, base64 encoded. Platforms that have no
 *     secret-file feature (Railway, Fly, most PaaS) can only pass secrets as
 *     environment variables, and base64 avoids every quoting and newline
 *     problem that raw JSON in a shell hits.
 *  2. `MPC_SHARE_JSON` — the share JSON verbatim, for anything that can carry
 *     it safely.
 *  3. The file at `path` — how Render (Secret Files) and docker compose do it.
 *
 * The env forms are read first so a deployment can override a baked-in file.
 */
export function loadShare(path: string): ShareFile {
  const b64 = process.env.MPC_SHARE_B64?.trim()
  if (b64) return parseShare(Buffer.from(b64, 'base64').toString('utf-8'), 'MPC_SHARE_B64')

  const raw = process.env.MPC_SHARE_JSON?.trim()
  if (raw) return parseShare(raw, 'MPC_SHARE_JSON')

  if (!existsSync(path)) {
    throw new Error(
      `No share. Set MPC_SHARE_B64 or MPC_SHARE_JSON, or put a share file at ` +
        `${path}. Run \`pnpm mpc:dkg\` to generate one.`,
    )
  }
  return parseShare(readFileSync(path, 'utf-8'), path)
}

/** Parse and check shape, so a truncated secret fails clearly at boot. */
function parseShare(text: string, source: string): ShareFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`Share from ${source} is not valid JSON: ${(e as Error).message}`)
  }
  const s = parsed as Partial<ShareFile>
  if (s?.role !== 'p1' && s?.role !== 'p2') {
    throw new Error(`Share from ${source} has no valid \`role\` field`)
  }
  if (!s.groupPkXY?.x || !s.groupPkXY?.y || !s.share) {
    throw new Error(`Share from ${source} is missing groupPkXY or share`)
  }
  return s as ShareFile
}

export function saveShare(path: string, share: ShareFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(share, null, 2))
}
