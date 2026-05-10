## Access Instructions

### 1. Install the SDK

```bash
npm i soda-sdk
```

### 2. Read the Documentation

Full SDK documentation, API reference, and integration guide:
**[YOUR DEPLOYED DOCS URL]**

### 3. Run the End-to-End Demo

A Solana program signs and broadcasts a real Sepolia transaction via the Soda primitive.

```bash
git clone https://github.com/derek2403/frontier.git
cd frontier
npm i
cp .env.example .env
```

Fill in the values in `.env` before continuing, then run:

```bash
./demo.sh
```

The script will derive the EVM address from a Solana PDA, request a signature, and execute a contract call on Sepolia. Verify the transaction on Etherscan once the script completes.
