// Server side of the /alpenglow demo. Testnet only.
//
// The Base Sepolia sponsor (SEPOLIA_FUNDER_KEY) plays two roles here:
//   1. the relayer, which pays gas for the certificate and the action;
//   2. the seed of the SIMULATED validator set (see validators.ts).
// Neither role can move the SODA account's funds: the account only runs an
// action whose approval sits under a certified Solana block.

import fs from "node:fs";
import os from "node:os";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  formatEther,
  http,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { AAVE_V3_BASE_SEPOLIA } from "@soda-sdk/core";

import {
  ALPENGLOW,
  DEPOSIT_WEI,
  MEMO_PROGRAM_ID,
  parseApprovalMemo,
  type AccountState,
  type Approval,
  type EvmTxReport,
} from "./shared";
import { buildValidatorSet, signCertificate, type ValidatorSet } from "./validators";
import localDeployment from "./local-deployment.json";

// Two networks share this code. "devnet" signs certificates with SIMULATED
// validator keys. "local" is our own Alpenglow node (solana-test-validator
// --alpenglow): its certificates are real and come from its block footers.
export type Net = "devnet" | "local";
export const LOCAL_RPC = process.env.ALPENGLOW_LOCAL_RPC_URL || "http://127.0.0.1:8899";
export function netConfig(net: Net) {
  return net === "local"
    ? { solanaRpc: LOCAL_RPC, lightClient: localDeployment.lightClient as Hex, factory: localDeployment.factory as Hex }
    : { solanaRpc: DEVNET_RPC, lightClient: ALPENGLOW.lightClient as Hex, factory: ALPENGLOW.factory as Hex };
}

export const LC_ABI = parseAbi([
  "struct NonSigner { bytes pk; uint64 stake; bytes32[] proof; }",
  "function submitCertificate(bytes32 blockId, bytes32 approvalsRoot, bytes sig, NonSigner[] nonSigners)",
  "function finalized(bytes32) view returns (bytes32)",
  "function validatorRoot() view returns (bytes32)",
]);
export const FACTORY_ABI = parseAbi([
  "function accountAddress(bytes32 owner, bytes32 path) view returns (address)",
  "function deployAndExecute(bytes32 owner, bytes32 path, address target, uint256 value, bytes data, uint64 nonce, uint64 deadline, bytes32 blockId, bytes32[] proof) returns (address)",
]);
export const ACCOUNT_ABI = parseAbi([
  "function nonce() view returns (uint64)",
  "function execute(address target, uint256 value, bytes data, uint64 nonce, uint64 deadline, bytes32 blockId, bytes32[] proof) returns (bytes)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const GATEWAY_ABI = parseAbi(["function depositETH(address pool, address onBehalfOf, uint16 referralCode)"]);

export const PATH0 = `0x${"00".repeat(32)}` as Hex;
const FUND_WEI = 500_000_000_000_000n; // 0.0005 ETH, five deposits

// Public endpoints by default. The Alchemy keys in .env hit their monthly
// quota on 21 Oct 2026, and the public ones are enough for one demo.
const BASE_RPC = process.env.ALPENGLOW_BASE_RPC_URL || "https://sepolia.base.org";
export const DEVNET_RPC = process.env.ALPENGLOW_SOLANA_RPC_URL || "https://api.devnet.solana.com";

export const pub = createPublicClient({ chain: baseSepolia, transport: http(BASE_RPC) });

function funderKey(): Hex {
  const raw = (process.env.SEPOLIA_FUNDER_KEY ?? "").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("SEPOLIA_FUNDER_KEY is not set: the Alpenglow demo needs it as relayer and validator seed");
  }
  return `0x${raw}`;
}

export function relayer() {
  const account = privateKeyToAccount(funderKey());
  return createWalletClient({ account, chain: baseSepolia, transport: http(BASE_RPC) });
}

// Building 1,000 BLS keys takes about 0.3 s, so do it once per process.
let setPromise: Promise<ValidatorSet> | null = null;
export function validatorSet(): Promise<ValidatorSet> {
  setPromise ??= (async () => {
    const set = buildValidatorSet(funderKey());
    const onChain = await pub.readContract({ address: ALPENGLOW.lightClient, abi: LC_ABI, functionName: "validatorRoot" });
    if (onChain.toLowerCase() !== set.root.toLowerCase()) {
      throw new Error(
        `validator set mismatch: light client has ${onChain}, this server's SEPOLIA_FUNDER_KEY gives ${set.root}. ` +
          "Run scripts/alpenglow-deploy.ts with the same key.",
      );
    }
    return set;
  })().catch((e) => {
    setPromise = null;
    throw e;
  });
  return setPromise;
}

export function ownerHex(owner: string): Hex {
  return `0x${Buffer.from(new PublicKey(owner).toBytes()).toString("hex")}`;
}

export function depositCalldata(account: Hex): Hex {
  return encodeFunctionData({
    abi: GATEWAY_ABI,
    functionName: "depositETH",
    args: [AAVE_V3_BASE_SEPOLIA.POOL as Hex, account, 0],
  });
}

export function approvalLeaf(a: Approval, owner: Hex): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "address", "bytes32", "address", "uint256", "bytes32", "uint64", "uint64"],
      [BigInt(a.chainId), a.account, owner, a.target, a.value, a.dataHash, a.nonce, a.deadline],
    ),
  );
}

export async function accountState(owner: string, net: Net = "devnet"): Promise<AccountState> {
  const cfg = netConfig(net);
  const oh = ownerHex(owner);
  const account = await pub.readContract({
    address: cfg.factory,
    abi: FACTORY_ABI,
    functionName: "accountAddress",
    args: [oh, PATH0],
  });
  const [code, balance, aWeth] = await Promise.all([
    pub.getCode({ address: account }),
    pub.getBalance({ address: account }),
    pub.readContract({ address: AAVE_V3_BASE_SEPOLIA.A_WETH as Hex, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
  ]);
  const deployed = !!code && code !== "0x";
  const nonce = deployed
    ? await pub.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "nonce" })
    : 0n;
  return {
    owner,
    ownerHex: oh,
    account,
    deployed,
    nonce: nonce.toString(),
    balanceWei: balance.toString(),
    aWethWei: aWeth.toString(),
    lightClient: cfg.lightClient,
    factory: cfg.factory,
  };
}

/** Sends one Base Sepolia transaction from the relayer and measures it. */
export async function sendAndMeasure(send: () => Promise<Hex>): Promise<EvmTxReport> {
  const t0 = performance.now();
  const hash = await send();
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  const ms = Math.round(performance.now() - t0);
  if (r.status !== "success") throw new Error(`Base Sepolia tx reverted: ${hash}`);
  const tx = await pub.getTransaction({ hash });
  const l1Fee = (r as unknown as { l1Fee?: bigint }).l1Fee ?? 0n;
  return {
    hash,
    gasUsed: Number(r.gasUsed),
    feeWei: (r.gasUsed * r.effectiveGasPrice + l1Fee).toString(),
    calldataBytes: (tx.input.length - 2) / 2,
    ms,
  };
}

export async function fundIfNeeded(account: Hex, balance: bigint): Promise<EvmTxReport | undefined> {
  if (balance >= DEPOSIT_WEI) return undefined;
  const w = relayer();
  const have = await pub.getBalance({ address: w.account.address });
  if (have < FUND_WEI * 2n) throw new Error(`relayer ${w.account.address} is low: ${formatEther(have)} ETH`);
  return sendAndMeasure(() => w.sendTransaction({ to: account, value: FUND_WEI }));
}

/**
 * Reads a FINALIZED devnet transaction and returns the approval it carries.
 * Checks that the memo is the one demo action and that the owner signed it.
 * In a real light client this check is a proof against the certified block;
 * here the server reads the block from an RPC (see "What is simulated").
 */
const approvals = new Map<string, Promise<Awaited<ReturnType<typeof readApprovalUncached>>>>();
export function readApproval(signature: string, net: Net = "devnet") {
  // certify and execute both need it; read the chain once per signature.
  let p = approvals.get(signature);
  if (!p) {
    p = readApprovalUncached(signature, net);
    approvals.set(signature, p);
    p.catch(() => approvals.delete(signature));
    if (approvals.size > 200) approvals.delete(approvals.keys().next().value!);
  }
  return p;
}

async function readApprovalUncached(signature: string, net: Net) {
  const conn = new Connection(netConfig(net).solanaRpc, "finalized");
  let tx = null;
  for (let i = 0; i < 20 && !tx; i++) {
    tx = await conn.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!tx) await new Promise((r) => setTimeout(r, 250));
  }
  if (!tx) throw new Error(`approval transaction is not finalized on ${net === "local" ? "the local Alpenglow network" : "Solana devnet"} yet`);
  if (tx.meta?.err) throw new Error("approval transaction failed on Solana");

  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys;
  const memoIx = msg.compiledInstructions.find((ix) => keys[ix.programIdIndex].toBase58() === MEMO_PROGRAM_ID);
  if (!memoIx) throw new Error("no memo instruction in the approval transaction");
  const memo = Buffer.from(memoIx.data).toString("utf8");
  const approval = parseApprovalMemo(memo);
  if (!approval) throw new Error("memo is not a SODA Alpenglow approval");

  // The memo program fails the transaction unless every account it lists
  // signed, so a listed signer is a signature from that key.
  const signers = memoIx.accountKeyIndexes.filter((i) => msg.isAccountSigner(i)).map((i) => keys[i].toBase58());
  if (signers.length !== 1) throw new Error("approval must name exactly one owner");
  const owner = signers[0];

  const [block, state] = await Promise.all([
    conn.getBlock(tx.slot, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
      transactionDetails: "none",
      rewards: false,
    }),
    accountState(owner, net),
  ]);
  if (!block) throw new Error(`block ${tx.slot} not available`);

  // Refuse anything except the demo action for this owner's account.
  if (approval.chainId !== ALPENGLOW.chainId) throw new Error("approval is for another chain");
  if (approval.account.toLowerCase() !== state.account.toLowerCase()) throw new Error("approval is for another account");
  if (approval.target.toLowerCase() !== AAVE_V3_BASE_SEPOLIA.WETH_GATEWAY.toLowerCase()) throw new Error("only the Aave deposit is allowed");
  if (approval.value !== DEPOSIT_WEI) throw new Error("only a 0.0001 ETH deposit is allowed");
  const data = depositCalldata(state.account);
  if (approval.dataHash !== keccak256(data)) throw new Error("approval data does not match the deposit");

  return {
    approval,
    owner,
    ownerHex: state.ownerHex,
    state,
    data,
    slot: tx.slot,
    blockhash: block.blockhash,
    blockId: `0x${Buffer.from(new PublicKey(block.blockhash).toBytes()).toString("hex")}` as Hex,
  };
}

export async function certify(signature: string, nonSignerCount: number) {
  const a = await readApproval(signature);
  const set = await validatorSet();
  // This block carries one SODA approval, so its root is that leaf.
  const approvalsRoot = approvalLeaf(a.approval, a.ownerHex);
  const t0 = performance.now();
  const cert = signCertificate(set, a.blockId, approvalsRoot, nonSignerCount);
  const signMs = Math.round(performance.now() - t0);
  const w = relayer();
  const tx = await sendAndMeasure(() =>
    w.writeContract({
      address: ALPENGLOW.lightClient,
      abi: LC_ABI,
      functionName: "submitCertificate",
      args: [a.blockId, approvalsRoot, cert.sig, cert.nonSigners],
    }),
  );
  return {
    slot: a.slot,
    blockhash: a.blockhash,
    blockId: a.blockId,
    approvalsRoot,
    validators: set.vals.length,
    nonSigners: nonSignerCount,
    signedStakePct: cert.signedStakePct,
    signMs,
    tx,
  };
}

export async function execute(signature: string, net: Net = "devnet") {
  const cfg = netConfig(net);
  const a = await readApproval(signature, net);
  // Devnet names a block by its blockhash; the local light client names it by
  // the real Alpenglow block_id from the certificate.
  const blockId = net === "local" ? localBlockIds.get(signature) : a.blockId;
  if (!blockId) throw new Error("certify this approval first");
  // Retry: the public RPC is load balanced and can answer from a node that
  // has not seen the certificate's block yet.
  let certified: Hex = "0x";
  for (let i = 0; i < 20; i++) {
    certified = await pub.readContract({
      address: cfg.lightClient,
      abi: LC_ABI,
      functionName: "finalized",
      args: [blockId],
    });
    if (!/^0x0+$/.test(certified)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (/^0x0+$/.test(certified)) throw new Error("this Solana block has no certificate on Base Sepolia yet");
  const w = relayer();
  const { approval: p } = a;
  const tx = await sendAndMeasure(() =>
    a.state.deployed
      ? w.writeContract({
          address: a.state.account,
          abi: ACCOUNT_ABI,
          functionName: "execute",
          args: [p.target, p.value, a.data, p.nonce, p.deadline, blockId, []],
        })
      : w.writeContract({
          address: cfg.factory,
          abi: FACTORY_ABI,
          functionName: "deployAndExecute",
          args: [a.ownerHex, PATH0, p.target, p.value, a.data, p.nonce, p.deadline, blockId, []],
        }),
  );
  // The public RPC is load balanced and can answer from a node one block
  // behind; wait until it shows the new nonce before reporting balances.
  let after = await accountState(a.owner, net);
  for (let i = 0; i < 12 && BigInt(after.nonce) <= p.nonce; i++) {
    await new Promise((r) => setTimeout(r, 250));
    after = await accountState(a.owner, net);
  }
  return { account: a.state.account, deployedNow: !a.state.deployed, tx, aWethWei: after.aWethWei };
}

// Optional: a devnet key the server signs approvals with, so the demo still
// runs if Phantom is on another network. ALPENGLOW_DEVNET_KEY_JSON (a JSON
// byte array) first; on a laptop, the Solana CLI wallet.
export function demoOwner(): Keypair | null {
  const raw = process.env.ALPENGLOW_DEVNET_KEY_JSON;
  try {
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    const p = `${os.homedir()}/.config/solana/id.json`;
    if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  } catch {
    return null;
  }
  return null;
}

export function memoInstruction(memo: string, owner: PublicKey) {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8"),
  });
}

export async function demoSign(memo: string, net: Net = "devnet") {
  const kp = demoOwner();
  if (!kp) throw new Error("no demo owner key on this server");
  if (!parseApprovalMemo(memo)) throw new Error("memo is not a SODA Alpenglow approval");
  const conn = new Connection(netConfig(net).solanaRpc, "confirmed");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
    memoInstruction(memo, kp.publicKey),
  );
  tx.sign(kp);
  return { tx: tx.serialize().toString("base64"), lastValidBlockHeight };
}

/** block_id from the real certificate, per approval signature (set by certifyLocal). */
export const localBlockIds: Map<string, Hex> =
  ((globalThis as Record<string, unknown>).__agLocalBlockIds as Map<string, Hex>) ??
  ((globalThis as Record<string, unknown>).__agLocalBlockIds = new Map<string, Hex>());
