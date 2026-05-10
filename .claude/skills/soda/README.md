# SODA — Claude Code skill

A self-contained skill that teaches an AI agent (Claude Code, Codex,
or any agent that supports Anthropic-style skills) to install and use
[`@soda-sdk/core`](https://www.npmjs.com/package/@soda-sdk/core) for
signing external-chain (Ethereum, Bitcoin, any ECDSA chain) transactions
from a Solana program.

## Use it inside this repo

If you're working in this repo, the skill is already wired up — Claude
Code picks it up from `.claude/skills/soda/` automatically. Just say:

> Use SODA to sign an Ethereum transaction from a Solana program

Claude Code routes through this skill.

## Use it in your own project

Copy the skill folder into your global Claude Code skills directory:

```bash
mkdir -p ~/.claude/skills
cp -r .claude/skills/soda ~/.claude/skills/soda
```

Now `claude` in any project can invoke the skill:

```
> /soda
```

Or trigger it implicitly by mentioning `@soda-sdk/core`, "SODA chain
signatures", or "sign Ethereum from Solana".

## Use it with Codex / other agents

`SKILL.md` is just a markdown file with YAML frontmatter, so anything
that reads agent skill files can use it. Drop it wherever your agent
expects skills (Codex: `~/.codex/skills/soda/`).

## What the skill teaches

- Installation: `pnpm add @soda-sdk/core @solana/web3.js @noble/hashes`
- The full request → sign → broadcast pipeline (7 steps).
- Exact API signatures for every export so the agent doesn't hallucinate.
- The two ways to issue `request_signature` (Anchor CPI vs. client-side ix).
- Common errors and what they mean.
- The "just try it" path for quick demos (clone the reference repo).

## License

MIT, same as `@soda-sdk/core`.
