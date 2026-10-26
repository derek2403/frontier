// One-time deploy of the /alpenglow demo contracts to Base Sepolia.
//
//   cd apps/web && npx tsx scripts/alpenglow-deploy.ts
//
// Reads SEPOLIA_FUNDER_KEY from the repo-root .env, compiles nothing (it uses
// research/alpenglow-sim/out/AlpenglowSim.json), deploys SolanaLightClient
// and SodaAccountFactory, loads the simulated validator set, and writes the
// addresses to lib/alpenglow/deployment.json for the page and API routes.

import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { buildValidatorSet, DST, g1Hex, N_VALIDATORS, THRESHOLD_PCT } from "../lib/alpenglow/validators";

const root = path.resolve(__dirname, "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1].trim();
const funderKey = get("SEPOLIA_FUNDER_KEY");
if (!funderKey) throw new Error("SEPOLIA_FUNDER_KEY missing from .env");
// Public RPC by default: the Alchemy key in .env ran out of monthly quota.
const rpc = get("ALPENGLOW_BASE_RPC_URL") || "https://sepolia.base.org";

const C = JSON.parse(
  fs.readFileSync(path.join(root, "research/alpenglow-sim/out/AlpenglowSim.json"), "utf8"),
);
const account = privateKeyToAccount(`0x${funderKey.replace(/^0x/, "")}` as Hex);
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

async function main() {
  console.log(`funder ${account.address}`);
  const t0 = performance.now();
  const set = buildValidatorSet(funderKey!);
  console.log(`validator set: ${N_VALIDATORS} keys in ${Math.round(performance.now() - t0)} ms, root ${set.root}`);

  const negG1 = g1Hex(bls.G1.ProjectivePoint.BASE.negate());
  const lcHash = await wallet.deployContract({
    abi: C.SolanaLightClient.abi,
    bytecode: C.SolanaLightClient.bytecode,
    args: [toHex(DST), negG1, BigInt(THRESHOLD_PCT)],
  });
  const lc = (await pub.waitForTransactionReceipt({ hash: lcHash })).contractAddress!;
  console.log(`light client ${lc}`);

  const fHash = await wallet.deployContract({
    abi: C.SodaAccountFactory.abi,
    bytecode: C.SodaAccountFactory.bytecode,
    args: [lc],
  });
  const factory = (await pub.waitForTransactionReceipt({ hash: fHash })).contractAddress!;
  console.log(`factory ${factory}`);

  const eHash = await wallet.writeContract({
    address: lc,
    abi: C.SolanaLightClient.abi,
    functionName: "setEpoch",
    args: [g1Hex(set.aggPk), set.totalStake, set.root],
  });
  const er = await pub.waitForTransactionReceipt({ hash: eHash });
  if (er.status !== "success") throw new Error(`setEpoch reverted ${eHash}`);
  console.log(`epoch set ${eHash}`);

  const out = {
    chainId: baseSepolia.id,
    lightClient: lc,
    factory,
    validators: N_VALIDATORS,
    thresholdPct: THRESHOLD_PCT,
    deployedAt: new Date().toISOString(),
    deployTxs: { lightClient: lcHash, factory: fHash, epoch: eHash },
  };
  fs.writeFileSync(path.join(__dirname, "../lib/alpenglow/deployment.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("wrote lib/alpenglow/deployment.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
