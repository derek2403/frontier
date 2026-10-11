import "@/styles/globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import type { AppProps } from "next/app";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";

// Devnet (default) or whatever the embedded env overrides to. The wallet
// adapter doesn't care which cluster — Phantom will sign txs for any
// network we tell it about.
const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
// Optional. web3.js derives the WebSocket from the RPC host, which is wrong
// for providers that serve them separately (Solami: rpc.solami.dev for HTTP,
// ws.solami.dev/ws/sol for WebSocket). Must be referenced literally so Next
// inlines it into the browser bundle.
const SOLANA_WS = process.env.NEXT_PUBLIC_SOLANA_WS_URL || undefined;

export default function App({ Component, pageProps }: AppProps) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const config = useMemo(
    () => ({ commitment: "confirmed" as const, wsEndpoint: SOLANA_WS }),
    [],
  );
  return (
    <ConnectionProvider endpoint={SOLANA_RPC} config={config}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Component {...pageProps} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

