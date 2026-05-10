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

  get endpoint(): string {
    return this.url;
  }
}
