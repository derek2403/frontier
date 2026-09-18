import type { Connection } from "@solana/web3.js";

/**
 * How much longer to keep polling a signature after Anchor's own confirmation
 * wait has already given up on it.
 */
export const EXTRA_CONFIRM_MS = 90_000;

/**
 * Send a Solana transaction and do not give up on it too early.
 *
 * Anchor's `.rpc()` waits through web3.js `confirmTransaction`, which throws
 * `TransactionExpiredTimeoutError` after 30 seconds. That error says outright
 * that it is "unknown if it succeeded or failed" — and on devnet it usually
 * did succeed, a few seconds later. Treating it as a failure is wrong twice
 * over: it reports a working pipeline as broken, and by then the user has
 * already approved in their wallet and spent the gas.
 *
 * Devnet confirmation was measured at 0.9s, 1.5s and 11.1s in three
 * consecutive samples, so it is the tail that needs headroom, not the median.
 *
 * On a timeout this keeps the signature the error carries and polls for its
 * status. A real on-chain error still throws at once, and a transaction that
 * never lands still fails — just after a deadline worth waiting for.
 */
export async function sendAndWait(
  connection: Connection,
  send: () => Promise<string>,
  what = "transaction",
  extraWaitMs: number = EXTRA_CONFIRM_MS,
): Promise<string> {
  let signature: string;
  try {
    return await send();
  } catch (e) {
    const sig = (e as { signature?: string }).signature;
    if (!sig) throw e;
    signature = sig;
  }

  const deadline = Date.now() + extraWaitMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) {
      throw new Error(
        `${what} ${signature} failed on-chain: ${JSON.stringify(status.err)}`,
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return signature;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(
    `${what} ${signature} did not confirm within ${
      (extraWaitMs + 30_000) / 1000
    }s. It may still land, so check it on Solana Explorer rather than ` +
      `retrying — a retry builds the same SigRequest PDA and would collide.`,
  );
}
