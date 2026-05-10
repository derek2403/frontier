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

export function loadShare(path: string): ShareFile {
  if (!existsSync(path)) {
    throw new Error(
      `Share file missing at ${path}. Run \`pnpm dkg\` to generate one.`,
    )
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as ShareFile
}

export function saveShare(path: string, share: ShareFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(share, null, 2))
}
