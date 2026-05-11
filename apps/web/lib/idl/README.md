# Web IDLs

These JSON files are the Anchor IDLs the web app imports at build time. They live
inside `apps/web/` (not under `contracts/target/`) so Vercel can resolve them
without needing to run `anchor build` during deploy.

## Current state

Both files are **stubs** with empty instructions/accounts arrays. The web app
builds and renders, but any code path that actually invokes the soda or eth_demo
program from the browser will throw at runtime.

## How to refresh with the real IDLs (do this before any production deploy)

```bash
# 1. Generate the real IDLs locally
cd /Users/derekliew/Developer/frontier/contracts
anchor build
cd ..

# 2. Copy them into the web app
cp contracts/target/idl/soda.json     apps/web/lib/idl/soda.json
cp contracts/target/idl/eth_demo.json apps/web/lib/idl/eth_demo.json

# 3. Commit + push
git add apps/web/lib/idl/soda.json apps/web/lib/idl/eth_demo.json
git commit -m "chore(web): refresh IDLs from anchor build"
git push
```

Vercel will redeploy automatically. After this, the web app's program calls will
work end-to-end against the deployed soda + eth_demo programs.

## Why this lives in apps/web/lib/idl/ instead of contracts/target/idl/

`contracts/target/` is gitignored (Rust build output). Vercel only checks out the
repo, it never runs `anchor build`. So the JSON imports in `apps/web/lib/idls.ts`
have to point at a path that is committed. This directory is that path.
