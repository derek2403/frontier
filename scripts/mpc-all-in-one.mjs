#!/usr/bin/env node
/**
 * Run the whole MPC stack inside one container: node p1, node p2 and the
 * coordinator, as three processes under one supervisor.
 *
 * WHAT THIS COSTS YOU
 *
 * One container means one filesystem, and that filesystem holds BOTH shares.
 * Anyone who reaches inside this container can reconstruct the joint secret.
 * That is the exact property the 2-of-2 protocol exists to prevent, so in
 * this mode the committee is a single-key signer wearing a protocol.
 *
 * Use it for a demo on a free platform that bills per service, or for local
 * work. Do not use it when you need the security claim to be true. For that,
 * run `apps/mpc-node` twice on two hosts plus `apps/mpc-coordinator` on a
 * third — see apps/docs/pages/deploy/render-mpc.mdx.
 *
 * Only the coordinator listens on the platform's $PORT. Both nodes bind to
 * loopback ports that are not routed anywhere, and the supervisor mints a
 * random per-boot token they require, so nothing outside can address them
 * even if another port were exposed.
 *
 * Environment:
 *   PORT                 public port for the coordinator (Render injects it)
 *   MPC_SHARE_P1_PATH    default /etc/secrets/share-p1.json
 *   MPC_SHARE_P2_PATH    default /etc/secrets/share-p2.json
 *   MPC_AUTH_TOKEN       token callers must present to the coordinator
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PUBLIC_PORT = process.env.PORT ?? '8000'
const P1_PORT = process.env.MPC_P1_PORT ?? '8101'
const P2_PORT = process.env.MPC_P2_PORT ?? '8102'
const SHARE_P1 = process.env.MPC_SHARE_P1_PATH ?? '/etc/secrets/share-p1.json'
const SHARE_P2 = process.env.MPC_SHARE_P2_PATH ?? '/etc/secrets/share-p2.json'

// Minted per boot. The nodes are on loopback, so no operator ever needs to
// see or configure this.
const NODE_TOKEN = randomBytes(32).toString('base64url')

for (const [label, path] of [['p1', SHARE_P1], ['p2', SHARE_P2]]) {
  if (!existsSync(path)) {
    console.error(
      `[supervisor] share for ${label} missing at ${path}\n` +
        `[supervisor] On Render, add it under Settings -> Secret Files.`,
    )
    process.exit(1)
  }
}

console.log('[supervisor] starting p1, p2 and coordinator in one container')
console.log(`[supervisor] coordinator will listen on ${PUBLIC_PORT}`)
console.warn(
  '[supervisor] WARNING: both shares are on this one filesystem. ' +
    'The 2-of-2 security property does not hold in this mode.',
)

const children = []
let shuttingDown = false

function start(name, cwd, env) {
  const bin = resolve(REPO_ROOT, cwd, 'node_modules/.bin/tsx')
  const child = spawn(bin, ['src/server.ts'], {
    cwd: resolve(REPO_ROOT, cwd),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const prefix = (stream, out) => {
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) out.write(`[${name}] ${line}\n`)
    })
  }
  prefix(child.stdout, process.stdout)
  prefix(child.stderr, process.stderr)

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    // One dead process means the committee cannot sign. Exit so the platform
    // restarts the whole container rather than leaving a half-dead stack that
    // still answers the health check.
    console.error(`[supervisor] ${name} exited (code=${code} signal=${signal})`)
    shutdown(1)
  })

  children.push(child)
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) c.kill('SIGTERM')
  setTimeout(() => process.exit(code), 500).unref()
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

start('p1', 'apps/mpc-node', {
  MPC_ROLE: 'p1',
  PORT: P1_PORT,
  MPC_SHARE_PATH: SHARE_P1,
  MPC_AUTH_TOKEN: NODE_TOKEN,
})

start('p2', 'apps/mpc-node', {
  MPC_ROLE: 'p2',
  PORT: P2_PORT,
  MPC_SHARE_PATH: SHARE_P2,
  MPC_AUTH_TOKEN: NODE_TOKEN,
})

start('coordinator', 'apps/mpc-coordinator', {
  PORT: PUBLIC_PORT,
  MPC_NODE_P1_URL: `http://127.0.0.1:${P1_PORT}`,
  MPC_NODE_P2_URL: `http://127.0.0.1:${P2_PORT}`,
  MPC_NODE_AUTH_TOKEN: NODE_TOKEN,
  // Callers still authenticate to the coordinator; it is the public face.
  MPC_AUTH_TOKEN: process.env.MPC_AUTH_TOKEN ?? '',
  // Peers are on loopback and never sleep, so skip the wake-up round trip.
  MPC_PREWARM_PEERS: '0',
})
