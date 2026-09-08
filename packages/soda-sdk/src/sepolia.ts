// Tiny Sepolia (or any EVM) JSON-RPC client. URL is a constructor argument so
// the same class works browser-side or server-side.

export class EthRpc {
  constructor(private readonly url: string) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const resp = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await resp.json()) as {
      result?: T;
      error?: { message: string };
    };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  async getBalance(addrHex: string): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getBalance", [addrHex, "latest"]));
  }

  async getNonce(addrHex: string): Promise<bigint> {
    return BigInt(
      await this.call<string>("eth_getTransactionCount", [addrHex, "pending"]),
    );
  }

  async getGasPrice(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_gasPrice", []));
  }

  async sendRawTransaction(signedHex: string): Promise<string> {
    return await this.call<string>("eth_sendRawTransaction", [signedHex]);
  }

  /** Read-only contract call at `latest`; returns the raw ABI-encoded hex. */
  async ethCall(toHex: string, data: Uint8Array): Promise<string> {
    return await this.call<string>("eth_call", [
      { to: toHex, data: "0x" + Buffer.from(data).toString("hex") },
      "latest",
    ]);
  }

  /**
   * Simulate a transaction and return the gas it would use. The node runs the
   * call, so a contract that would revert (Aave refusing a borrow, say) fails
   * HERE with the revert reason — before anything is signed or broadcast.
   */
  async estimateGas(tx: {
    from: string;
    to: string;
    data: Uint8Array;
    valueWei?: bigint;
  }): Promise<bigint> {
    return BigInt(
      await this.call<string>("eth_estimateGas", [
        {
          from: tx.from,
          to: tx.to,
          data: "0x" + Buffer.from(tx.data).toString("hex"),
          ...(tx.valueWei && tx.valueWei > 0n
            ? { value: "0x" + tx.valueWei.toString(16) }
            : {}),
        },
      ]),
    );
  }

  get endpoint(): string {
    return this.url;
  }
}
