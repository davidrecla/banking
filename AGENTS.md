# banking -- Agent/Developer Notes

PGC Bank demo app, used to showcase **API Shield** and **WAF** payload
scanning to customers. Cloudflare Worker (vanilla JS) serving a static UI
from `public/` plus a REST API under `/api/*`, backed by D1, KV and R2.

**Read `BUILD-PLAN.md` first** in any new session on this repo. It is the
reference spec: architecture decisions, D1 schema, demo credentials,
provisioned Cloudflare resources, the phase checklist, and a "Local
Environment Notes" section listing eight environment quirks that have each
already cost real debugging time (the `wrangler d1 execute --file` failure,
the curl TLS revocation error, the `setx`/process-restart trap, PowerShell
JSON quoting, and more). Do not re-derive any of that -- check there first.

This file covers only what `BUILD-PLAN.md` does not.

## Commands

```bash
npm install          # install deps (wrangler only; see lockfile note below)
npm run dev          # wrangler dev -- prefer `npx wrangler dev --remote`,
                     # which hits the real D1 and the real JWT secret (KV/R2
                     # use separate preview resources; see BUILD-PLAN note 4).
                     # Requires wrangler 4.x on this network.
npx wrangler deploy --dry-run   # ALWAYS run before pushing wrangler.toml changes
npm run deploy       # wrangler deploy (rarely needed -- main auto-deploys)
```

## Deployment is automatic -- mind what you push

`main` is the production branch and **auto-deploys to
https://banking.davidrecla.workers.dev via Cloudflare Workers Builds on
every push**. Feature branches also auto-build and get their own preview
URL. Use the branch -> PR -> check the preview URL -> merge workflow in
`BUILD-PLAN.md` note 8; do not push directly to `main` for anything
non-trivial. This applies to dependency and config changes too, not just
code -- see the lockfile note below.

## Project location -- keep this on C:

The repo lives at `C:\Users\drecla\Dev Projects\banking`. It was migrated
here from the Google-Drive-synced `G:\My Drive\Developer Folder\...` path,
where it sat nested inside a redundant wrapper folder that had its own
stray empty git repo. **Do not move it back onto `G:`** -- Drive sync makes
`npm install` unusably slow and corrupts git indexes. From C: a clean
install finishes in about 12 seconds. Git history, all branches and the
`origin` remote came across intact; nothing needs re-cloning.

## No lockfile is committed

`package-lock.json` is **not tracked** (and not gitignored) -- the repo has
never committed one, so `npm install` generates a fresh one locally and
Workers Builds resolves dependencies itself at build time. Committing one
would make builds reproducible, which is worth doing, but treat it as a
real change rather than a chore:

- It pins the dependency graph that CI installs, so it alters what gets
  built and therefore deployed. Because a push to `main` auto-deploys,
  land it on a branch and verify the preview URL before merging.
- `npm audit` reported 6 advisories (2 moderate, 4 high) in `ws` via
  wrangler 3.x. **Resolved:** wrangler is now pinned to `^4.131.1` and
  `npm audit` reports 0 vulnerabilities. The upgrade was done deliberately
  on a branch and re-tested with `wrangler dev --remote` plus a
  `deploy --dry-run`; it was also what made `dev --remote` work again on
  this network (see `BUILD-PLAN.md` note 4).

## Transient Cloudflare API failures

`wrangler` commands occasionally fail once with:

```
A request to the Cloudflare API (/memberships) failed.
Authentication failed (status: 400) [code: 9106]
```

This is **transient, not a misconfiguration**. It was observed once and
then did not reproduce across five consecutive runs of the same command in
the same shell with the same token. `wrangler.toml` intentionally carries no
`account_id` and does not need one -- the token resolves the account fine.
If you hit it, just retry; only investigate the token (`npx wrangler
whoami`, and `BUILD-PLAN.md` notes 3 and 5) if it fails repeatedly.

## Customer-facing POC plan

The customer-facing POC plan for this engagement lives in Google Drive (user-owned,
edited there -- treat it as the external spec this demo must match):
https://docs.google.com/document/d/17s4V1Z3ctmQmUW4q1cN2H9L67xUGeBMzHRO6q2lH2S0/edit
Read it through the Google Workspace MCP (docs_get), never from a local stub. Note:
the Drive *search* tool was intermittently broken (2026-09-22); direct doc reads by
URL/ID work.

## Verified-healthy baseline

Last confirmed working in production: homepage returns 200, `/api/accounts`
correctly returns 401 unauthenticated, and `/api/auth/login` returns 400
with `{"error":"username and password are required"}` for an empty body.
No 500s on those paths means the D1, KV, R2 and Assets bindings are all
resolving. Useful as a quick smoke test after any deploy -- note the curl
TLS caveat in `BUILD-PLAN.md` note 2.
