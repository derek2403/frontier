// Anchor IDLs for the deployed programs.
//
// These are committed under apps/web/lib/idl/ (not contracts/target/) so Vercel
// can resolve them without running `anchor build`. The files are stubs by default;
// refresh them from `contracts/target/idl/` after each anchor build. See
// ./idl/README.md for the refresh procedure.

import sodaIdl from "./idl/soda.json";
import ethDemoIdl from "./idl/eth_demo.json";
import suiDemoIdl from "./idl/sui_demo.json";

export { sodaIdl, ethDemoIdl, suiDemoIdl };

export const SODA_PROGRAM_ID: string = (sodaIdl as { address: string }).address;
export const ETH_DEMO_PROGRAM_ID: string = (ethDemoIdl as { address: string }).address;
export const SUI_DEMO_PROGRAM_ID: string = (suiDemoIdl as { address: string }).address;
