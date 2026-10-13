# SODA on Solami

SODA lets a Solana wallet, or a Solana program, control an address on another
chain. A Solana program records each request, a 2-of-2 MPC committee signs it,
and Solana itself checks the signature before anything is broadcast.

This file explains what [Solami](https://solami.dev) does for SODA, which part
of the code uses which Solami product, and how to run it with your own Solami
key.

## In one sentence

SODA's off-chain services must see Solana events quickly and land one
critical transaction quickly. Solami's gRPC streams and Beam do exactly those
two jobs, and its RPC and WebSocket carry everything else.

## What each Solami product does here

| Solami product | Used by | Its job in SODA | Problem it fixed |
|---|---|---|---|
| **Yellowstone gRPC** | `apps/relayer`, `apps/mpc-subscriber` | Streams every transaction that touches the SODA programs, about 0.5 s after the block, so the services see `SigRequested` and `SigCompleted` events | Our previous provider rejected `logsSubscribe`, so both services had to fall back to the slow public RPC |
| **WebSocket** | the browser, the relayer, the subscriber | Live subscriptions, including transaction confirmations | Our previous provider rejected `signatureSubscribe`, which made the page hang for 30 s on transactions that had already landed |
| **HTTP RPC** (Amsterdam) | every service, the MPC nodes, the CLI | All reads and sends. The MPC nodes re-read each request from Solana here before they agree to sign. | One provider for everything, in the same city as our servers |
| **Beam** (stake-weighted landing) | `apps/mpc-subscriber` | Lands `finalize_signature`, the step that must reach Solana before the Ethereum transaction can be broadcast | This is the one latency-critical transaction in the pipeline |

## How a request flows through Solami

1. A user approves one transaction in Phantom. The SODA program builds the
   Ethereum transaction on Solana and records a `SigRequest`.
2. **gRPC** delivers that event to the subscriber.
3. The two MPC nodes each read the request over **Solami RPC**, check it
   themselves, and produce one signature together. Neither node holds the
   whole key.
4. The subscriber lands `finalize_signature` through **Beam**. Solana runs
   `secp256k1_recover` and accepts the signature only if it belongs to the
   address the program derived.
5. **gRPC** delivers `SigCompleted` to the relayer, which broadcasts the signed
   transaction to the other chain.

## Mainnet deployment

Deployed on 13 October 2026. Both programs were checked byte for byte against
the source builds.

| Item | Address |
|---|---|
| `soda` program | `afbLp3atZ9J6w1PjCsgGx7ALrgBVuMvcJPmwczTrQw3` |
| `eth_demo` program | `DZaBAkQac4DTwoXcoCuMDa76onxAdN6im3s5jcrV5GSw` |
| Committee account | `7E3rmQ241iqWCbQ3GUH4KC45DfuFwTjaFeTz5WrbgzW7` |
| Committee public key | `039e4c1ac3a50367eefb5d05d1a18620037b20f2f52fc434bb7c7363081e21c5c5` |

The other chain is **Base Sepolia** (a testnet), so no real funds move on that
side.

## Run it with your own Solami key

1. Sign up at [solami.dev](https://solami.dev) and create two keys:
   - a **server key**: type *API key*, no roles. It covers RPC, gRPC and Beam.
   - a **browser key**: type *RPC key*, **Frontend only** on, **Use for gRPC**
     off, and a domain allowlist with your site's domains.
2. For Beam, create a **SwQoS key** in the Beam section of the dashboard and
   keep its keypair (base58).
3. Set the variables below. **Never** put the server key in a variable that
   starts with `NEXT_PUBLIC_`; those are built into the page that every visitor
   downloads.

Every variable is optional. With none set, SODA runs on Solana devnet with its
original providers, exactly as before.

### Relayer and subscriber (server)

| Variable | Value |
|---|---|
| `SOLANA_RPC_URL` | `https://rpc.solami.dev/solana/ams?api-key=<server key>` |
| `SOLANA_WS_URL` | `wss://ws.solami.dev/ws/sol?api_key=<server key>` |
| `SOLAMI_GRPC_URL` | `https://grpc.solami.dev:443` |
| `SOLAMI_GRPC_TOKEN` | `<server key>` |
| `SODA_PROGRAM_ID` | `afbLp3atZ9J6w1PjCsgGx7ALrgBVuMvcJPmwczTrQw3` |
| `ETH_DEMO_PROGRAM_ID` (relayer) | `DZaBAkQac4DTwoXcoCuMDa76onxAdN6im3s5jcrV5GSw` |
| `SOLAMI_SWQOS_KEY` (subscriber) | your SwQoS keypair, base58 — turns on Beam |
| `SOLAMI_BEAM_TIP_SOL` (subscriber) | tip per landed transaction, default `0.0001` |

`SOLANA_WS_URL` is required with Solami. Solami serves WebSocket on a
different host from HTTP, and without it the code would connect to the wrong
address and receive nothing.

### MPC nodes (server)

| Variable | Value |
|---|---|
| `SOLANA_RPC_URL` | `https://rpc.solami.dev/solana/ams?api-key=<server key>` |
| `SODA_PROGRAM_ID` | `afbLp3atZ9J6w1PjCsgGx7ALrgBVuMvcJPmwczTrQw3` |

### Web app (browser)

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://rpc.solami.dev/solana/ams?api-key=<browser key>` |
| `NEXT_PUBLIC_SOLANA_WS_URL` | `wss://ws.solami.dev/ws/sol?api_key=<browser key>` |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `mainnet-beta` (makes explorer links point at mainnet) |
| `NEXT_PUBLIC_SODA_PROGRAM_ID` | `afbLp3atZ9J6w1PjCsgGx7ALrgBVuMvcJPmwczTrQw3` |
| `NEXT_PUBLIC_ETH_DEMO_PROGRAM_ID` | `DZaBAkQac4DTwoXcoCuMDa76onxAdN6im3s5jcrV5GSw` |

`NEXT_PUBLIC_*` values are built into the page, so set them before the build.

### The CLI demo against mainnet

```bash
SOLANA_RPC_URL="https://rpc.solami.dev/solana/ams?api-key=$SOLAMI_API_KEY" \
SOLANA_WS_URL="wss://ws.solami.dev/ws/sol?api_key=$SOLAMI_API_KEY" \
SOLANA_CLUSTER=mainnet \
SODA_IDL_PATH=contracts/target/mainnet/soda.json \
ETH_DEMO_IDL_PATH=contracts/target/mainnet/eth_demo.json \
pnpm --filter demo demo
```

## What we tested

| Test | Result |
|---|---|
| HTTP RPC on mainnet | `getLatestBlockhash` in 173 ms |
| WebSocket `logsSubscribe` | 2,253 events in 6 s |
| WebSocket `signatureSubscribe` | accepted (our previous provider refused it) |
| gRPC transaction stream, filtered by program | 928 transactions in 6 s, first one after 467 ms |
| Relayer on the gRPC feed | transactions arrive and reach the existing event decoder |
| Relayer with no Solami variables set | unchanged: devnet, WebSocket feed, no errors |
| Browser key from `sodalabs.org` | accepted |
| Browser key from another site, or with no origin | rejected: `domain not allowed` / `requires browser Origin header` |
| Browser key used for gRPC | rejected |
| A full SODA request on mainnet | `5TDW1uKh…` (`SignEthTransfer`, address derived on-chain) and `gT8Eu9w2…` (`FinalizeSignature`: "secp256k1_recover OK -- signature matches stored foreign_pk_xy"), through Solami RPC |
| Relayer on Railway, mainnet | `Event feed: gRPC https://grpc.solami.dev:443`, then `gRPC stream subscribed` |

## What changed in the code

| Area | Change |
|---|---|
| `contracts/` | A `mainnet` build flag switches the program addresses, so one source builds both devnet and mainnet |
| `apps/relayer` | New `src/grpc-feed.ts`: Yellowstone gRPC feed with reconnect and backoff, feeding the existing decoders. Program addresses can be set by env var. |
| `apps/mpc-subscriber` | gRPC feed and Beam landing for `finalize_signature`, falling back to a normal send if Beam fails. Docker image moves to Debian, because Beam's QUIC library needs glibc. |
| `apps/web` | Program addresses, cluster and WebSocket URL set by env var; explorer links follow the cluster |
| `apps/demo` | Can point at the mainnet program files and label links for mainnet |

## Status

- **Live on mainnet since 13 October 2026.** [sodalabs.org](https://sodalabs.org)
  and all Railway services use the mainnet programs and Solami RPC, WebSocket
  and gRPC.
- **Beam:** the code is on `main` and switched off on the servers until a SwQoS
  key registered in the Solami dashboard is set as `SOLAMI_SWQOS_KEY`.
- **Plan:** the Solami Pro plan from the hackathon runs until 18 October 2026
  and does not renew. After that the account falls back to the free tier, so
  the gRPC streams need a plan or pay-as-you-go to keep running.

## Honest limits

- The committee is **2-of-2 under one operator**. If one node stops, signing
  stops, and the operator controls both shares. The next version needs 2-of-3
  with independent operators.
- The other chain is a testnet. The Solana side is mainnet; the Ethereum side is
  Base Sepolia.
