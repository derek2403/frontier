// Which Solana cluster the page links to and names.
//
// The Solana transaction links used to hard-code the devnet cluster, so a
// mainnet build would send every viewer to a devnet page where the
// transaction does not exist. NEXT_PUBLIC_SOLANA_CLUSTER is inlined at build
// time, like the program ids in ./idls.ts. Unset or empty = devnet.

const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER?.trim() || "devnet";

// Explorers (XRAY, Solscan, Solana Explorer) show mainnet when the link has
// no cluster parameter, so mainnet gets none.
const isMainnet = cluster === "mainnet-beta" || cluster === "mainnet";

/** Cluster name for page text: "mainnet", "devnet", ... */
export const SOLANA_CLUSTER_LABEL: string = isMainnet ? "mainnet" : cluster;

/** Helius XRAY page for a Solana transaction on the configured cluster. */
export function solanaTxUrl(signature: string): string {
  const query = isMainnet ? "" : `?network=${encodeURIComponent(cluster)}`;
  return `https://xray.helius.xyz/tx/${signature}${query}`;
}
