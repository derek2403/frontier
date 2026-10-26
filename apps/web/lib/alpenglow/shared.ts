// Shared by the /alpenglow page and its API routes. Testnet only: Solana
// devnet (which runs Alpenglow) and Base Sepolia.
//
// The owner's action request for another chain is a Solana transaction whose
// Memo holds every field of the action, so anyone can read the approval on an explorer.
// The server rebuilds the same fields from the memo and refuses anything that
// is not the one demo action (an Aave V3 deposit of DEPOSIT_WEI).

import deployment from "./deployment.json";

export const ALPENGLOW = deployment as {
  chainId: number;
  lightClient: `0x${string}`;
  factory: `0x${string}`;
  validators: number;
  thresholdPct: number;
  deployedAt: string;
  deployTxs: Record<string, string>;
};

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_PREFIX = "SODA cross-chain action v1";
export const DEPOSIT_WEI = 100_000_000_000_000n; // 0.0001 ETH
export const NON_SIGNER_CHOICES = [0, 20, 50] as const;

// Measured on Base Sepolia, 14 Oct 2026: the same Aave deposit sent by the
// SODA MPC path from a normal address (tx 0x12acc10c…).
export const MPC_BASELINE = {
  gasUsed: 158_421,
  tx: "0x12acc10c2b9544e7861ae2413fd28a6b265c07dc03e15a91799b402be26621bb",
  blockToBlockMs: 4_000,
};

export type Approval = {
  chainId: number;
  account: `0x${string}`;
  target: `0x${string}`;
  value: bigint;
  dataHash: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
};

export function approvalMemo(a: Approval): string {
  return [
    MEMO_PREFIX,
    // For people reading it on an explorer; the fields below are what count.
    "action=aave-v3-deposit",
    `chain=${a.chainId}`,
    `account=${a.account}`,
    `target=${a.target}`,
    `value=${a.value}`,
    `data=${a.dataHash}`,
    `nonce=${a.nonce}`,
    `deadline=${a.deadline}`,
  ].join("|");
}

export function parseApprovalMemo(memo: string): Approval | null {
  const parts = memo.split("|");
  if (parts[0] !== MEMO_PREFIX) return null;
  const f = Object.fromEntries(parts.slice(1).map((p) => p.split("=", 2)));
  const hex = (v: string | undefined, len: number) =>
    v && new RegExp(`^0x[0-9a-fA-F]{${len}}$`).test(v) ? (v as `0x${string}`) : null;
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? BigInt(v) : null);
  const account = hex(f.account, 40);
  const target = hex(f.target, 40);
  const dataHash = hex(f.data, 64);
  const chainId = num(f.chain);
  const value = num(f.value);
  const nonce = num(f.nonce);
  const deadline = num(f.deadline);
  if (!account || !target || !dataHash || chainId == null || value == null || nonce == null || deadline == null) {
    return null;
  }
  return { chainId: Number(chainId), account, target, value, dataHash, nonce, deadline };
}

// Shapes the API routes return.
export type EvmTxReport = {
  hash: string;
  gasUsed: number;
  feeWei: string;
  calldataBytes: number;
  ms: number;
};

export type AccountState = {
  owner: string;
  ownerHex: `0x${string}`;
  account: `0x${string}`;
  deployed: boolean;
  nonce: string;
  balanceWei: string;
  aWethWei: string;
  lightClient: string;
  factory: string;
};

export type PrepareResponse = AccountState & {
  memo: string;
  funding?: EvmTxReport;
};

export type CertifyResponse = {
  slot: number;
  blockhash: string;
  blockId: `0x${string}`;
  approvalsRoot: `0x${string}`;
  validators: number;
  nonSigners: number;
  signedStakePct: number;
  signMs: number;
  tx: EvmTxReport;
  /** Present on the local network, where the certificate is a real Alpenglow one. */
  real?: {
    kind: string;
    signature: string;
    bitmap: string;
    payload: string;
    shredVersion: number;
    validatorSetSync: EvmTxReport | null;
    attest: EvmTxReport;
  };
};

export type NetName = "devnet" | "local";

export type ExecuteResponse = {
  account: string;
  deployedNow: boolean;
  tx: EvmTxReport;
  aWethWei: string;
};
