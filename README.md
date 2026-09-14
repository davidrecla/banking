# PGC Bank

A demo Internet-banking application built as a single Cloudflare Worker. It
exists to showcase **Cloudflare API Shield** and **WAF payload/content
scanning** to customers: the app deliberately ships a set of exploitable
vulnerabilities alongside its legitimate API, so a demo can show attacks
succeeding against the app — and then being blocked at the Cloudflare edge
without any origin change.

- **Production:** https://banking.puregroundscoffee.com (also live at
  https://banking.davidrecla.workers.dev)
- **Build plan / reference spec:** [BUILD-PLAN.md](BUILD-PLAN.md) — read it
  first; it documents architecture, schema, demo credentials, provisioned
  resources and the local-environment quirks that have already cost debugging
  time.
- **Full endpoint reference:** [API_REFERENCE.md](API_REFERENCE.md)
- **OpenAPI schema:** [openapi-schema.yaml](openapi-schema.yaml) — legitimate
  endpoints only, for upload into API Shield schema validation.

## Architecture

One Worker serving both the static UI (`public/`, via Workers Assets) and a
REST API under `/api/*`:

| Layer | Technology |
|---|---|
| Compute | Cloudflare Worker (`src/index.js` router + `src/routes/*`) |
| Relational data | Cloudflare D1 (`BANK_DB`) — users, accounts, transactions, loans, bills, investments, transfers, cards, statements, notifications, audit logs |
| Rate-limit counters | Cloudflare KV (`BANK_KV`) |
| File storage (uploads + generated statements) | Cloudflare R2 (`BANK_BUCKET`) |
| Auth | Hand-rolled HS256 JWT in `src/lib/crypto.js`, password hashing via PBKDF2 (Web Crypto), secret held in the `JWT_SECRET` Worker secret |

The ledger reconciles: every account balance equals the sum of its completed
ledger entries, and every money movement writes its ledger rows and balance
update in one D1 `batch()`.

Every UI action maps to a documented public API call — no UI-only logic
bypasses the API, which is what makes the same functionality exercisable from
curl in a demo.

## Phase 4 — security showcase

`src/routes/vulnerable.js` implements nine intentionally vulnerable endpoints
covering the OWASP API Security Top 10 (API10 was deliberately dropped; see the
matrix in BUILD-PLAN.md). They are isolated from the legitimate surface and
each handler documents the check it skips and the Cloudflare control expected
to block it.

Two scripts drive the demo:

```bash
./test-api.sh                 # contract check of the legitimate API
./attack-simulation.sh before # every exploit succeeds (vulnerable baseline)
./attack-simulation.sh after  # every exploit blocked at the Cloudflare edge
```

Both default to production; override with `BASE_URL=http://127.0.0.1:8787`
for local `wrangler dev`. Windows network note: both scripts use
`curl.exe --ssl-no-revoke` deliberately (see BUILD-PLAN.md).

## Development

```bash
npm install
npx wrangler dev --remote   # local dev against the real D1/KV/R2 resources
npm run deploy              # rarely needed — main auto-deploys via Workers Builds
```

Workflow: feature branch → PR → Cloudflare builds a preview URL → test → merge.
Do not push non-trivial changes directly to `main`.
