// Anchor IDLs for the deployed programs. Imported from the contracts target/idl
// directory so a fresh `anchor build` updates the types here automatically.

import sodaIdl from "../../../contracts/target/idl/soda.json";
import ethDemoIdl from "../../../contracts/target/idl/eth_demo.json";

export { sodaIdl, ethDemoIdl };

export const SODA_PROGRAM_ID: string = (sodaIdl as { address: string }).address;
export const ETH_DEMO_PROGRAM_ID: string = (ethDemoIdl as { address: string }).address;

export const SEPOLIA_CHAIN_ID = 11_155_111n;
