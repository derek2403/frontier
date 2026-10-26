// The "local" network of the /alpenglow demo: our own Alpenglow node
// (solana-test-validator --alpenglow, Agave 4.3.2) with the Yellowstone gRPC
// plugin. Its block footers carry REAL Alpenglow finality certificates, and
// AlpenglowLightClient on Base Sepolia checks them with the real formats:
//   signed bytes  tag | slot u64 LE | block_id (notarize only) | shred_version u16 LE
//   bitmap        solana-signer-store base2, rank = stake desc, then BLS key asc
//   rule          fast: notarize at 80%;  slow: finalize 60% + notarize 60%
//
// Not proved, and done by named roles on the light client instead:
//   - the admin loads the validator set (here: read from our node)
//   - the attester posts the approvals root (no inclusion proof exists yet)

import path from "node:path";
import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { parseAbi, type Hex } from "viem";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";

import { approvalLeaf, LOCAL_RPC, netConfig, pub, readApproval, relayer, sendAndMeasure, localBlockIds } from "./server";

const LOCAL_GRPC = process.env.ALPENGLOW_LOCAL_GRPC || "127.0.0.1:10000";
const DST = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";

export const ALC_ABI = parseAbi([
  "function setValidators(bytes[] pks, uint64[] stakes, uint16 shredVersion)",
  "function submitFinalCert(uint64 slot, bytes32 blockId, bytes finalSig, bytes finalBitmap, bytes notarSig, bytes notarBitmap)",
  "function attestApprovals(bytes32 blockId, bytes32 root)",
  "function finalizedSlot(bytes32) view returns (uint64)",
  "function validatorCount() view returns (uint256)",
  "function shredVersion() view returns (uint16)",
  "function pks(uint256) view returns (bytes)",
  "function stakes(uint256) view returns (uint64)",
]);

type Aggregate = { signature: Uint8Array; block_id?: Uint8Array; signer_bitmap: Uint8Array };
type FinalCert = { slot: string; final_aggregate: Aggregate; notar_aggregate?: Aggregate };
type Validator = { vote: string; stake: bigint; compressed: Uint8Array; pk: InstanceType<typeof bls.G1.ProjectivePoint> };

const fp = (x: bigint) => x.toString(16).padStart(128, "0");
const g1 = (P: Validator["pk"]): Hex => {
  const a = P.toAffine();
  return `0x${fp(a.x)}${fp(a.y)}`;
};
const g2 = (bytes: Uint8Array): Hex => {
  const a = bls.G2.ProjectivePoint.fromHex(bytes).toAffine();
  return `0x${fp(a.x.c0)}${fp(a.x.c1)}${fp(a.y.c0)}${fp(a.y.c1)}`;
};
const hx = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(LOCAL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const o: number[] = [];
  while (n > 0n) {
    o.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === "1") o.unshift(0);
    else break;
  }
  return Uint8Array.from(o);
}
const cmp = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** The node's validator set in Agave's rank order. */
export async function readValidatorSet() {
  type VA = { votePubkey: string; activatedStake: number };
  const va = await rpc<{ current: VA[]; delinquent: VA[] }>("getVoteAccounts");
  const all = [...va.current, ...va.delinquent].filter((v) => v.activatedStake > 0);
  const infos = await rpc<{ value: ({ data?: { parsed?: { info?: { blsPubkeyCompressed?: string } } } } | null)[] }>(
    "getMultipleAccounts",
    [all.map((v) => v.votePubkey), { encoding: "jsonParsed" }],
  );
  const vals: Validator[] = [];
  all.forEach((v, i) => {
    const k = infos.value[i]?.data?.parsed?.info?.blsPubkeyCompressed;
    if (!k) return;
    const compressed = b58(k);
    vals.push({ vote: v.votePubkey, stake: BigInt(v.activatedStake), compressed, pk: bls.G1.ProjectivePoint.fromHex(compressed) });
  });
  vals.sort((a, b) => (a.stake === b.stake ? cmp(a.compressed, b.compressed) : a.stake > b.stake ? -1 : 1));
  const nodes = await rpc<{ shredVersion?: number }[]>("getClusterNodes");
  const shredVersion = nodes.map((n) => n.shredVersion).find((x) => x != null) ?? 0;
  return { vals, shredVersion };
}

/** Loads the node's validator set into the light client when it differs (admin role). */
async function syncValidatorSet(vals: Validator[], shredVersion: number) {
  const lc = netConfig("local").lightClient;
  const [count, sv] = await Promise.all([
    pub.readContract({ address: lc, abi: ALC_ABI, functionName: "validatorCount" }),
    pub.readContract({ address: lc, abi: ALC_ABI, functionName: "shredVersion" }),
  ]);
  let same = Number(count) === vals.length && sv === shredVersion;
  if (same) {
    const onChain = await Promise.all(vals.map((_, i) => pub.readContract({ address: lc, abi: ALC_ABI, functionName: "pks", args: [BigInt(i)] })));
    same = onChain.every((pk, i) => pk.toLowerCase() === g1(vals[i].pk).toLowerCase());
  }
  if (same) return null;
  const w = relayer();
  return sendAndMeasure(() =>
    w.writeContract({
      address: lc,
      abi: ALC_ABI,
      functionName: "setValidators",
      args: [vals.map((v) => g1(v.pk)), vals.map((v) => v.stake), shredVersion],
    }),
  );
}

// ---- block footer stream: one subscription per server process ----
type Store = { certs: Map<number, FinalCert>; started: boolean; lastError?: string; genesis?: string };
const store: Store =
  ((globalThis as Record<string, unknown>).__agFooterStore as Store) ??
  ((globalThis as Record<string, unknown>).__agFooterStore = { certs: new Map(), started: false });

function startFooterStream() {
  if (store.started) return;
  store.started = true;
  // A restarted stream may be a new chain whose slots start again at 0.
  store.certs.clear();
  const def = loader.loadSync("geyser.proto", {
    includeDirs: [path.join(process.cwd(), "lib/alpenglow/proto")],
    keepCase: true,
    longs: String,
    defaults: false,
    oneofs: true,
  });
  const geyser = (grpc.loadPackageDefinition(def) as unknown as { geyser: { Geyser: new (a: string, c: grpc.ChannelCredentials) => grpc.Client & { Subscribe: (m: grpc.Metadata) => grpc.ClientDuplexStream<unknown, { block_footer?: { block_final_cert?: FinalCert } }> } } }).geyser;
  const client = new geyser.Geyser(LOCAL_GRPC, grpc.credentials.createInsecure());
  const call = client.Subscribe(new grpc.Metadata());
  call.on("data", (u) => {
    const c = u.block_footer?.block_final_cert;
    if (!c) return;
    store.certs.set(Number(c.slot), c);
    if (store.certs.size > 5000) store.certs.delete(store.certs.keys().next().value!);
  });
  const restart = (e?: Error) => {
    store.lastError = e?.message;
    store.started = false;
    setTimeout(startFooterStream, 1000);
  };
  call.on("error", restart);
  call.on("end", () => restart());
  call.write({
    slots: {},
    accounts: {},
    transactions: {},
    transactions_status: {},
    blocks: {},
    blocks_meta: {},
    entry: {},
    accounts_data_slice: [],
    block_footer: { f: { include_certificates: true } },
    commitment: 0,
  });
}
export const ensureFooterStream = startFooterStream;

function payload(tag: number, slot: number, blockId: Uint8Array | null, shredVersion: number) {
  const out = new Uint8Array(blockId ? 43 : 11);
  const dv = new DataView(out.buffer);
  out[0] = tag;
  dv.setBigUint64(1, BigInt(slot), true);
  if (blockId) out.set(blockId, 9);
  dv.setUint16(blockId ? 41 : 9, shredVersion, true);
  return out;
}

/** Off-chain check of one aggregate; returns the signed stake share in percent. */
function verifyAggregate(agg: Aggregate, msg: Uint8Array, vals: Validator[]) {
  const bm = agg.signer_bitmap;
  if (bm[0] !== 0) throw new Error(`bitmap version ${bm[0]} not supported`);
  const n = bm[1] | (bm[2] << 8);
  if (n !== vals.length) throw new Error(`bitmap has ${n} validators, node has ${vals.length}`);
  let apk = bls.G1.ProjectivePoint.ZERO;
  let signed = 0n;
  for (let i = 0; i < n; i++) {
    if (!(bm[3 + (i >> 3)] & (1 << (i & 7)))) continue;
    apk = apk.add(vals[i].pk);
    signed += vals[i].stake;
  }
  const S = bls.G2.ProjectivePoint.fromHex(agg.signature);
  const H = bls.G2.hashToCurve(msg, { DST }) as unknown as InstanceType<typeof bls.G2.ProjectivePoint>;
  if (!bls.fields.Fp12.eql(bls.pairing(apk, H), bls.pairing(bls.G1.ProjectivePoint.BASE, S))) throw new Error("bad signature");
  const total = vals.reduce((a, v) => a + v.stake, 0n);
  return Number((signed * 10_000n) / total) / 100;
}

/** Drops certificates from an earlier chain: a reset node reuses slot numbers. */
async function checkGenesis() {
  const genesis = await rpc<string>("getGenesisHash");
  // Unknown or different chain: the cached certificates cannot be trusted to match.
  if (store.genesis !== genesis) store.certs.clear();
  store.genesis = genesis;
}

export async function certifyLocal(signature: string) {
  startFooterStream();
  await checkGenesis();
  const a = await readApproval(signature, "local");
  const { vals, shredVersion } = await readValidatorSet();
  const sync = await syncValidatorSet(vals, shredVersion);

  // The footer of a later block carries this block's certificate.
  let cert: FinalCert | undefined;
  for (let i = 0; i < 80 && !(cert = store.certs.get(a.slot)); i++) await new Promise((r) => setTimeout(r, 100));
  if (!cert) {
    throw new Error(
      `no finality certificate seen for slot ${a.slot}. Is the Yellowstone plugin running on ${LOCAL_GRPC}?` +
        (store.lastError ? ` (${store.lastError})` : ""),
    );
  }
  const fast = !cert.notar_aggregate;
  const blockIdBytes = (cert.notar_aggregate ?? cert.final_aggregate).block_id!;
  const pct = fast
    ? verifyAggregate(cert.final_aggregate, payload(1, a.slot, blockIdBytes, shredVersion), vals)
    : Math.min(
        verifyAggregate(cert.final_aggregate, payload(2, a.slot, null, shredVersion), vals),
        verifyAggregate(cert.notar_aggregate!, payload(1, a.slot, blockIdBytes, shredVersion), vals),
      );
  const blockId = hx(blockIdBytes);
  const lc = netConfig("local").lightClient;
  const w = relayer();
  const tx = await sendAndMeasure(() =>
    w.writeContract({
      address: lc,
      abi: ALC_ABI,
      functionName: "submitFinalCert",
      args: [
        BigInt(a.slot),
        blockId,
        g2(cert!.final_aggregate.signature),
        hx(cert!.final_aggregate.signer_bitmap),
        fast ? "0x" : g2(cert!.notar_aggregate!.signature),
        fast ? "0x" : hx(cert!.notar_aggregate!.signer_bitmap),
      ],
    }),
  );
  // The public RPC can answer from a node one block behind.
  for (let i = 0; i < 20; i++) {
    const s = await pub.readContract({ address: lc, abi: ALC_ABI, functionName: "finalizedSlot", args: [blockId] });
    if (s !== 0n) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // NOT proved: the attester says this approval is in the block.
  const root = approvalLeaf(a.approval, a.ownerHex);
  const attest = await sendAndMeasure(() =>
    w.writeContract({ address: lc, abi: ALC_ABI, functionName: "attestApprovals", args: [blockId, root] }),
  );
  localBlockIds.set(signature, blockId);

  return {
    slot: a.slot,
    blockhash: a.blockhash,
    blockId,
    approvalsRoot: root,
    validators: vals.length,
    nonSigners: 0,
    signedStakePct: pct,
    signMs: 0,
    tx,
    real: {
      kind: fast ? "fast (notarize, 80%)" : "slow (finalize + notarize, 60%)",
      signature: hx(cert.final_aggregate.signature),
      bitmap: hx(cert.final_aggregate.signer_bitmap),
      payload: hx(payload(1, a.slot, blockIdBytes, shredVersion)),
      shredVersion,
      validatorSetSync: sync,
      attest,
    },
  };
}

export async function localStatus() {
  startFooterStream();
  await checkGenesis();
  const slot = await rpc<number>("getSlot", [{ commitment: "finalized" }]);
  const version = await rpc<{ "solana-core": string }>("getVersion");
  return { slot, version: version["solana-core"], certsSeen: store.certs.size, lastError: store.lastError ?? null, rpc: LOCAL_RPC };
}
