// Anchor IDLs for the deployed programs.
//
// These are committed under apps/web/lib/idl/ (not contracts/target/) so Vercel
// can resolve them without running `anchor build`. The files are stubs by default;
// refresh them from `contracts/target/idl/` after each anchor build. See
// ./idl/README.md for the refresh procedure.
//
// The committed files carry the DEVNET program ids. The program code is the
// same on every cluster, so a mainnet build only swaps each IDL's `address`
// through NEXT_PUBLIC_*_PROGRAM_ID. Every Anchor `Program` in this app (pages
// and API routes) is built from the objects exported here, so the override
// reaches all of them. Unset or empty = the committed devnet id.

import { PublicKey } from "@solana/web3.js";
import sodaIdlJson from "./idl/soda.json";
import ethDemoIdlJson from "./idl/eth_demo.json";
import suiDemoIdlJson from "./idl/sui_demo.json";

function withAddress<T extends { address: string }>(
  idl: T,
  envName: string,
  override: string | undefined,
): T {
  // `||`, not `??`: a dashboard variable saved empty must mean "unset".
  const address = override?.trim() || idl.address;
  try {
    new PublicKey(address);
  } catch {
    // Name the variable, or the only symptom is "Invalid public key input"
    // from somewhere deep inside a page.
    throw new Error(`${envName}="${address}" is not a valid Solana address`);
  }
  return address === idl.address ? idl : { ...idl, address };
}

// Each variable is written out in full, not looked up by a computed name:
// Next only inlines a NEXT_PUBLIC_ value into the browser bundle when the
// source spells out `process.env.NEXT_PUBLIC_...` literally.
export const sodaIdl = withAddress(
  sodaIdlJson,
  "NEXT_PUBLIC_SODA_PROGRAM_ID",
  process.env.NEXT_PUBLIC_SODA_PROGRAM_ID,
);
export const ethDemoIdl = withAddress(
  ethDemoIdlJson,
  "NEXT_PUBLIC_ETH_DEMO_PROGRAM_ID",
  process.env.NEXT_PUBLIC_ETH_DEMO_PROGRAM_ID,
);
export const suiDemoIdl = withAddress(
  suiDemoIdlJson,
  "NEXT_PUBLIC_SUI_DEMO_PROGRAM_ID",
  process.env.NEXT_PUBLIC_SUI_DEMO_PROGRAM_ID,
);

export const SODA_PROGRAM_ID: string = sodaIdl.address;
export const ETH_DEMO_PROGRAM_ID: string = ethDemoIdl.address;
export const SUI_DEMO_PROGRAM_ID: string = suiDemoIdl.address;
