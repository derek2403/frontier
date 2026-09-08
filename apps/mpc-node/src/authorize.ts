/**
 * Node-side authorization.
 *
 * Before this module existed, a node signed whatever 32-byte payload was
 * posted to it. The on-chain program was decorative from the signer's point
 * of view: anyone who could reach the URL could obtain a committee signature
 * for any payload and broadcast it straight to the foreign chain, because
 * Ethereum does not consult Solana.
 *
 * This is the fix, and it copies NEAR's model: every node independently reads
 * the SigRequest from its OWN Solana RPC and re-derives the tweak from what
 * the chain says. The caller supplies only an account address — never a
 * payload and never a tweak. A node therefore signs only what a confirmed
 * on-chain request already committed to.
 *
 * Note the requester-program ambiguity: the SODA tweak is keyed on the
 * *program* that requested the signature, but `SigRequest.requester` is the
 * signing wallet, and the program id is not stored on-chain (it was dropped
 * during the BPF stack refactor). So we try each configured known requester
 * and accept the one whose derived key reproduces the stored `foreign_pk_xy`.
 * That is still a sound check — it proves the stored key was derived from a
 * known program plus the on-chain seeds — but deriving in-program and storing
 * the input would make it unnecessary.
 */
import { Connection, PublicKey } from '@solana/web3.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

const DERIVATION_DOMAIN = new TextEncoder().encode('SODA-v1')

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
const SODA_PROGRAM_ID = process.env.SODA_PROGRAM_ID ?? ''
/** Comma-separated base58 program ids allowed to request signatures. */
const KNOWN_REQUESTERS = (process.env.SODA_KNOWN_REQUESTERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Unset disables the check, which restores the old blind-signing behaviour. */
export const AUTHORIZATION_ENABLED = Boolean(SODA_PROGRAM_ID)

export type AuthorizedRequest = {
  payloadHex: string
  tweakHex: string
  requesterProgram: string
}

export type SigRequestAccount = {
  requester: PublicKey
  foreignPkXY: Uint8Array
  derivationSeeds: Uint8Array
  payload: Uint8Array
  chainTag: Uint8Array
  expiresAt: bigint
  completed: boolean
}

/** sha256("account:SigRequest")[..8] — Anchor's account discriminator. */
const SIG_REQUEST_DISCRIMINATOR = sha256(
  new TextEncoder().encode('account:SigRequest'),
).slice(0, 8)

/**
 * Borsh layout of soda::state::SigRequest, after the 8-byte discriminator.
 *
 * This parses data fetched from the network, so every read is bounds-checked
 * before it happens. A malformed or wrong-type account must produce a clean
 * refusal, not a thrown RangeError that a caller could use to probe the node.
 */
export function decodeSigRequest(data: Buffer): SigRequestAccount {
  const need = (offset: number, len: number) => {
    if (offset + len > data.length) {
      throw new Error('account data too short for SigRequest')
    }
  }
  need(0, 8)
  if (!Buffer.from(SIG_REQUEST_DISCRIMINATOR).equals(data.subarray(0, 8))) {
    throw new Error('account is not a SigRequest')
  }

  let o = 8
  o += 1 // bump
  need(o, 32 + 32 + 64 + 4)
  const requester = new PublicKey(data.subarray(o, o + 32))
  o += 32
  o += 32 // committee
  const foreignPkXY = Uint8Array.from(data.subarray(o, o + 64))
  o += 64
  const seedsLen = data.readUInt32LE(o)
  o += 4
  // MAX_SEEDS_LEN on-chain is 64; anything larger means we are misparsing.
  if (seedsLen > 64) throw new Error('derivation_seeds length out of range')
  need(o, seedsLen + 32 + 32 + 8 + 1)
  const derivationSeeds = Uint8Array.from(data.subarray(o, o + seedsLen))
  o += seedsLen
  const payload = Uint8Array.from(data.subarray(o, o + 32))
  o += 32
  const chainTag = Uint8Array.from(data.subarray(o, o + 32))
  o += 32
  const expiresAt = data.readBigInt64LE(o)
  o += 8
  const completed = data[o] === 1
  return { requester, foreignPkXY, derivationSeeds, payload, chainTag, expiresAt, completed }
}

export function computeTweak(
  requesterProgram: Uint8Array,
  seeds: Uint8Array,
  chainTag: Uint8Array,
): Uint8Array {
  const h = sha256.create()
  h.update(DERIVATION_DOMAIN)
  h.update(requesterProgram)
  h.update(seeds)
  h.update(chainTag)
  return h.digest()
}

/** `group_pk + tweak*G`, returned as the 64-byte X||Y the program stores. */
export function deriveForeignPkXY(
  groupPkCompressed: Uint8Array,
  tweak: Uint8Array,
): Uint8Array {
  const t = BigInt('0x' + Buffer.from(tweak).toString('hex'))
  if (t === 0n || t >= secp256k1.Point.Fn.ORDER) {
    throw new Error('tweak out of range')
  }
  const point = secp256k1.Point.fromHex(Buffer.from(groupPkCompressed).toString('hex'))
  const derived = point.add(secp256k1.Point.BASE.multiply(t))
  return derived.toBytes(false).subarray(1)
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b))
}

let conn: Connection | null = null
function connection(): Connection {
  if (!conn) conn = new Connection(RPC_URL, 'confirmed')
  return conn
}

/**
 * Resolve a SigRequest account address into the payload and tweak this node
 * is willing to sign. Throws with a caller-safe reason if anything about the
 * request fails to check out.
 */
export async function authorize(
  sigRequestPubkey: string,
  groupPkCompressed: Uint8Array,
): Promise<AuthorizedRequest> {
  if (!AUTHORIZATION_ENABLED) {
    throw new Error('authorization not configured (set SODA_PROGRAM_ID)')
  }
  if (KNOWN_REQUESTERS.length === 0) {
    throw new Error('no SODA_KNOWN_REQUESTERS configured')
  }

  let pubkey: PublicKey
  try {
    pubkey = new PublicKey(sigRequestPubkey)
  } catch {
    throw new Error('sigRequestPubkey is not a valid address')
  }

  const acct = await connection().getAccountInfo(pubkey, 'confirmed')
  if (!acct) throw new Error('SigRequest account not found on-chain')
  if (!acct.owner.equals(new PublicKey(SODA_PROGRAM_ID))) {
    throw new Error('account is not owned by the SODA program')
  }

  const sr = decodeSigRequest(acct.data)
  if (sr.completed) throw new Error('request already completed')
  if (sr.expiresAt !== 0n && sr.expiresAt < BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error('request expired')
  }

  // Find which known requester program reproduces the stored foreign_pk.
  for (const programId of KNOWN_REQUESTERS) {
    const tweak = computeTweak(
      new PublicKey(programId).toBytes(),
      sr.derivationSeeds,
      sr.chainTag,
    )
    let derived: Uint8Array
    try {
      derived = deriveForeignPkXY(groupPkCompressed, tweak)
    } catch {
      continue
    }
    if (eq(derived, sr.foreignPkXY)) {
      return {
        payloadHex: Buffer.from(sr.payload).toString('hex'),
        tweakHex: Buffer.from(tweak).toString('hex'),
        requesterProgram: programId,
      }
    }
  }

  throw new Error(
    'stored foreign_pk does not match any known requester — refusing to sign',
  )
}
