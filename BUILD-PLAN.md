# PGC Bank Demo — Build Plan & Reference Spec

**Purpose:** Demo banking app on Cloudflare Workers, used to showcase **API Shield** and **WAF** (payload/content scanning) capabilities to a customer (Metrobank-style POC). Must have both a Web UI and a REST API, where every UI action maps to a documented API call.

**Base spec source:** `FUNCTIONALITY-SUMMARY.md` (original requirements doc, in the user's Downloads folder, not part of this repo), extended with security-showcase additions decided during planning.

**Status as of end of Phase 1: live in production.** Read this whole file before starting Phase 2 — it has everything needed to continue without re-deriving context.

---

## Quick Orientation (read this first)

- **Live production URL:** https://banking.davidrecla.workers.dev
- **GitHub repo:** `davidrecla/banking` (branch `main` = production, auto-deploys via Cloudflare Workers Builds on every push)
- **Cloudflare Worker name:** `banking`, account "Pure Grounds Coffee Co." (account ID `0feb844d7ff36330cdd00ed24797fe85`)
- **Workflow:** create a feature branch → commit/push → open a PR → Cloudflare posts a preview URL on the PR check → review → merge PR into `main` → Cloudflare auto-deploys to production. Do **not** push directly to `main` for non-trivial changes.
- **Tooling available locally:** `wrangler` (authenticated via `CLOUDFLARE_API_TOKEN` env var), `gh` (GitHub CLI, authenticated as `davidrecla`) — both already set up, see "Local Environment Notes" below.

### File structure
```
banking/
├── src/
│   ├── index.js              # Main Worker entry point / router (only handles /api/* — everything else falls through to Workers Assets)
│   ├── lib/
│   │   ├── crypto.js          # Password hashing (PBKDF2) + minimal HS256 JWT sign/verify (Web Crypto only, works in Node too)
│   │   ├── auth.js            # authenticate() middleware helper, jsonResponse()/errorResponse() helpers
│   │   └── ratelimit.js       # KV-backed counters: login attempts/min, daily transfer totals
│   └── routes/
│       ├── auth.js            # login, refresh, logout handlers
│       ├── accounts.js        # GET /api/accounts, GET /api/accounts/:id
│       ├── transfers.js       # POST /api/transfers/internal
│       └── uploads.js         # upload/list/download/delete handlers (R2 + D1 metadata)
├── public/                    # Static UI, served automatically by Workers Assets (see [assets] in wrangler.toml)
│   ├── index.html              # Login page
│   ├── dashboard.html          # Balances + internal transfer form
│   ├── uploads.html            # Documents/file upload page
│   ├── app.js                  # Shared client helpers: auth token storage, authFetch(), toasts, formatCurrency()
│   └── styles.css              # DBS-inspired styling (see "UI Design" section below)
├── schema/
│   └── 001_phase1_initial.sql # D1 schema (users, accounts, transactions, uploads) — reference copy; actually applied via individual --command calls, see below
├── scripts/
│   ├── generate-seed.mjs      # Generates .ps1 of wrangler d1 execute --command calls to seed 5 demo users + 15 accounts
│   └── update-passwords.mjs   # Generates .ps1 of UPDATE statements to change existing users' passwords (used when password scheme changed post-seed)
├── wrangler.toml               # Worker config: bindings (D1/KV/R2/Assets), no secrets here (JWT_SECRET is a real Cloudflare secret)
├── package.json
└── BUILD-PLAN.md               # This file
```

Two generated files are gitignored (regenerate via their `.mjs` source if needed): `scripts/seed-commands.ps1`, `scripts/update-passwords-commands.ps1`.

---

## Architecture Decisions

| Concern | Decision | Reason |
|---|---|---|
| Primary data store | **D1** (`bank-database`, binding `BANK_DB`) | Relational data (users, accounts, transactions, loans, etc.) needs joins, filtering, and atomic multi-row writes (e.g. a transfer debits one account + credits another together, done via `env.BANK_DB.batch([...])`) |
| Ephemeral / counters | **KV** (`BANK_KV`) | Rate-limit counters (login attempts/min, daily transfer totals), not relational |
| File storage | **R2** (`bank-bucket`, binding `BANK_BUCKET`) | Generated PDF/CSV statements (Phase 3), user-uploaded documents (Phase 1, done) |
| JWT signing key | **Cloudflare Secret** (`JWT_SECRET`, via `wrangler secret put`) | Single static app-wide value — correct use of Secrets. Already set; **do not** put it in `wrangler.toml` or commit it anywhere |
| User passwords | **Hashed in D1** (PBKDF2 + per-user random salt, via Web Crypto) | Never stored in plaintext, even for demo accounts. Hashing/verification implemented in `src/lib/crypto.js` |
| JWT implementation | **Hand-rolled HS256** in `src/lib/crypto.js` (no `jose`/library dependency) | Kept dependency-free per the project's "vanilla JS" convention; simple enough to implement directly with Web Crypto's HMAC |
| PDF generation (Phase 3, not yet built) | **`pdf-lib`** (pure JS, Workers-compatible) | No Node-specific APIs; Node PDF libs (pdfkit etc.) don't run in Workers runtime |
| Static UI hosting | **Workers Assets** (`[assets]` in `wrangler.toml`, `directory = "./public"`) | Lets one Worker serve both the API (`/api/*`) and the static SPA-ish UI from the same deployment/domain. Requests to `/api/*` fall through to the Worker's `fetch` handler automatically because no static file matches that path — no special routing config needed beyond the `[assets]` block |

---

## Demo User Accounts & Password Scheme

Password = first initial of first name + last name + `123` (lowercase); admin uses `admin123`.

| Username | Full Name | Password (plaintext, pre-hash) | Role |
|---|---|---|---|
| chris.brown | Chris Brown | `cbrown123` | Regular |
| sarah.johnson | Sarah Johnson | `sjohnson123` | Premium |
| mike.davis | Mike Davis | `mdavis123` | Basic |
| emma.wilson | Emma Wilson | `ewilson123` | VIP |
| admin | Admin User | `admin123` | Admin |

Each user has 3 accounts (Savings, Checking, Investment), seeded at **USD 3,000 each** (USD 9,000 total per user, USD 45,000 across all 5 users). Note: live balances have since shifted slightly from test transfers made during development (e.g. chris.brown ↔ sarah.johnson) — this is expected and fine for a demo.

**These credentials are intentionally NOT shown anywhere in the UI** (the login page used to display them but this was removed per instruction — this file is now the only place they're documented). If you reset/reseed the database, use `scripts/generate-seed.mjs` or `scripts/update-passwords.mjs` (see "Local Environment Notes" for how to run them, since a network quirk prevents the straightforward `wrangler d1 execute --file` approach).

Passwords are hashed with PBKDF2 (100,000 iterations, SHA-256, 16-byte random salt per user) — see `hashPassword()`/`verifyPassword()` in `src/lib/crypto.js`.

---

## D1 Schema — Current State (Phase 1)

Applied and live in `bank-database`. Reference copy in `schema/001_phase1_initial.sql` (note: not actually applied via that file directly — see "Local Environment Notes" for why).

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Regular',
  member_since TEXT NOT NULL,
  account_frozen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_type TEXT NOT NULL, -- savings | checking | investment
  account_number TEXT UNIQUE NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  type TEXT NOT NULL, -- deposit | withdrawal | transfer_in | transfer_out | bill_payment | loan_payment | investment_purchase
  amount REAL NOT NULL,
  merchant TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  r2_key TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- plus indexes on accounts.user_id, transactions.account_id, uploads.user_id
```

### Planned additions for later phases (not yet created)
```sql
transfers (id, from_account_id, to_account_id NULLABLE, external_bank NULLABLE, external_account_number NULLABLE, external_account_name NULLABLE, amount, note, fee, status, created_at)
bills (id, user_id FK, bill_type, payee_name, account_number, amount, due_date, confirmation_number, status, created_at)
payees (id, user_id FK, name, bill_type, account_number)
loans (id, user_id FK, amount, term_months, purpose, employment_info, income, interest_rate, monthly_payment, status, created_at)
investments (id, user_id FK, plan_type, amount, duration, projected_return, status, maturity_date, created_at)
cards (id, user_id FK, card_number_masked, expiry, cvv_masked, status, linked_account_id FK)
notifications (id, user_id FK, type, message, read, created_at)
audit_logs (id, user_id FK, event_type, ip_address, device_info, created_at)
statements (id, user_id FK, account_id NULLABLE, format, date_range_start, date_range_end, r2_key, created_at)
```

KV keys in use (not D1):
- `ratelimit:login:{username}` — login attempt counter, 60s TTL, max 5/min (see `src/lib/ratelimit.js`)
- `ratelimit:transfer:{userId}:{YYYY-MM-DD}` — cumulative daily internal-transfer total, ~26h TTL, capped at $1000/day

---

## API Endpoints — Current State (Phase 1, implemented and live)

All routes below live in `src/index.js` (the router) and are implemented in `src/routes/*.js`. Auth is enforced via `authenticate(request, env)` in `src/lib/auth.js`, which verifies the `Authorization: Bearer <jwt>` header.

### Public (no auth required)
- `POST /api/auth/login` — body `{ username, password }` → `{ token, expiresIn, user }`. Rate-limited to 5 attempts/min per username (429 if exceeded). 24h token expiry.
- `POST /api/auth/refresh` — body `{ token }` → new `{ token, expiresIn }` if the old one is still valid.
- `POST /api/auth/logout` — stateless no-op (JWTs aren't blacklisted in this demo; see code comment for how a real system would do it).

### Protected (require `Authorization: Bearer <jwt>`)
- `GET /api/accounts` — list the authenticated user's 3 accounts.
- `GET /api/accounts/:id` — single account detail (ownership-checked).
- `POST /api/transfers/internal` — body `{ fromAccountId, toUsername, toAccountType, amount, note? }`. Enforces $500/txn and $1000/day (KV-backed) limits, validates sufficient balance, writes two transaction rows (`transfer_out`/`transfer_in`) atomically via `env.BANK_DB.batch()`.
- `POST /api/uploads` — multipart/form-data with a `file` field. **No type/size restrictions** (intentional — for later WAF content-scanning tests). Stores the file in R2 (`bank-bucket`) under `uploads/{userId}/{uuid}-{filename}` and a metadata row in D1.
- `GET /api/uploads` — list the authenticated user's uploaded files (metadata only).
- `GET /api/uploads/:id` — download a file (streams from R2, ownership-checked).
- `DELETE /api/uploads/:id` — deletes both the R2 object and the D1 metadata row.

All responses are JSON except file downloads (raw bytes with correct `Content-Type`/`Content-Disposition`). CORS is wide open (`Access-Control-Allow-Origin: *`) since this is a demo.

### Planned for later phases (not yet implemented — this is where Phase 2 picks up)
```
POST /api/accounts/:id/freeze
POST /api/accounts/:id/unfreeze
POST /api/transfers/external        (5 mock banks, $1000/txn cap)
POST /api/transfers/batch
GET  /api/bills/payees
POST /api/bills/payees
POST /api/bills/pay                 ($2000/txn cap)
GET  /api/bills
POST /api/loans/apply               ($500-$10k, auto-approve <$2k)
GET  /api/loans
GET  /api/loans/:id
GET  /api/investments/plans
POST /api/investments               ($100-$5000)
GET  /api/investments
POST /api/investments/:id/withdraw
GET  /api/transactions              (filter/search/sort/paginate, ~80-100 seeded mock transactions)
GET  /api/transactions/:id
POST /api/statements/generate       (PDF via pdf-lib, or CSV) — Phase 3
GET  /api/statements                — Phase 3
GET  /api/statements/:id/download   — Phase 3
GET  /api/cards                     — Phase 3
POST /api/cards/:id/block           — Phase 3
POST /api/cards/:id/unblock         — Phase 3
GET  /api/notifications             — Phase 3
POST /api/notifications/:id/read    — Phase 3
GET  /api/audit-log                 — Phase 3
GET  /api/usage                     — Phase 3
```

---

## UI Design (Phase 1, implemented)

Redesigned to look like a real bank (originally had a generic Cloudflare-purple gradient look, replaced per instruction). Templated loosely after DBS Bank's site (https://www.dbs.com.sg), using DBS's official brand colors:
- Red: `#FF3333` (primary CTA color, accents)
- Black: `#000000` (top nav, headers)
- White: `#FFFFFF` (page background/cards)
- Gray `#484848` for secondary text

Design conventions used (see `public/styles.css`, CSS variables at the top):
- Black top nav bar with a red bottom border accent
- White cards with a red top border accent (`.balance-card`, `.login-card`)
- Red primary buttons (`.btn-primary`), black "danger" buttons (`.btn-danger`, used for Logout)
- No emoji icons anywhere (previously had 🏦💰💳 etc. — removed for a more professional/bank-like look)
- No demo credentials displayed on the login page (removed — they live only in this file now)

Pages: `index.html` (login), `dashboard.html` (balances + internal transfer form; other quick-action buttons for bills/loans/invest are visible but disabled with "Coming in Phase 2" tooltips), `uploads.html` (Documents page: upload/list/download/delete files).

`public/app.js` has shared helpers used by all pages: `getToken()`/`setSession()`/`getUser()`/`clearSession()` (localStorage-based), `requireAuth()` (redirects to `/` if not logged in), `authFetch()` (fetch wrapper that auto-attaches the Bearer token and redirects to login on 401), `formatCurrency()`, `showToast()`.

**Important UI convention to maintain in later phases:** every UI action must call the same public REST API — no UI-only logic that bypasses the API. This is a hard requirement from the original spec (so all UI functionality is exercisable/testable via direct API calls too, which matters for the API Shield demo).

---

## Intentional Vulnerabilities (Phase 4, NOT yet implemented) — mapped to OWASP API Security Top 10

| OWASP API # | Category | Endpoint (planned) | Vulnerability |
|---|---|---|---|
| API1 | Broken Object Level Authorization (BOLA) | `GET /api/admin/users/:userId/balance` | Any authenticated user can view another user's balance |
| API2 | Broken Authentication | `GET /api/internal/debug` | No authentication required; exposes user list, SSNs, internal config |
| API3 | Excessive Data Exposure | `GET /api/profile` | Returns full internal record (SSN, password hash field, internal flags) instead of just UI-needed fields |
| API4 | Unrestricted Resource Consumption | `POST /api/transfers/express` | No rate limiting applied |
| API5 | Broken Function Level Authorization (BFLA) | `GET /api/admin/users`, `POST /api/admin/loans/:id/force-approve` | No role check — regular users can call admin-only functions |
| API6 | Unrestricted Access to Sensitive Business Flows | Loan/investment endpoints | No cap on number of applications/investments per day |
| API7 | Server-Side Request Forgery (SSRF) | `POST /api/profile/avatar-from-url` (or bank-account verification) | Worker fetches a user-supplied URL server-side with no validation |
| API8 | Security Misconfiguration | Various | Verbose error messages leak stack traces / internal DB errors on malformed input |
| API9 | Improper Inventory Management | `GET /api/v1/accounts` | Deprecated, undocumented shadow endpoint still live, absent from OpenAPI schema — for API Discovery demo |
| API10 | Unsafe Consumption of 3rd-Party APIs | External transfer flow | Blindly trusts mock external bank's response without validation |

**Do not implement these until Phase 4**, and only on separate, clearly-named endpoints — keep them isolated from the legitimate API surface so the "before/after API Shield" story stays clean for the demo.

### WAF / Content Scanning Test Surfaces
- File uploads (`/api/uploads`, already built, no restrictions) — test with the **EICAR test string** (safe, industry-standard fake-malware test file) to validate malware/content scanning
- Free-text fields (transfer `note`, future bill memos/loan purpose) — intentionally left unfiltered so payloads reach the edge for WAF managed rule (SQLi/XSS) testing
- Future `POST /api/transfers/batch` — oversized JSON body to test body-size limits

### Optional Stretch Goal (Phase 5)
- **mTLS** on `/api/internal/*` routes (contrast with the intentionally-missing-auth `/api/internal/debug`) to demo API Shield's mTLS client-cert authentication

---

## Build Phases

### Phase 1 — Foundation — ✅ COMPLETE AND MERGED TO MAIN (live in production)
- [x] D1 schema: `users`, `accounts`, `transactions`, `uploads`
- [x] `JWT_SECRET` set as a Cloudflare Worker secret
- [x] Password hashing (PBKDF2 + per-user salt) + seed script; 5 demo users × 3 accounts × $3000 seeded
- [x] Auth endpoints: login (JWT, 24h expiry, rate-limited), refresh, logout
- [x] `GET /api/accounts`, `GET /api/accounts/:id`
- [x] `POST /api/transfers/internal` with $500/txn + $1000/day limits
- [x] Upload endpoints (`POST/GET/:id/DELETE /api/uploads`) via R2, no restrictions
- [x] Basic UI (login, dashboard, documents pages), DBS-inspired redesign, no demo creds shown in UI
- [x] Merged via PR #3 into `main`; verified live at https://banking.davidrecla.workers.dev

### Phase 2 — Extended Banking Features (START HERE NEXT)
- [ ] D1 schema additions: `bills`, `payees`, `loans`, `investments` (add a new `schema/002_phase2.sql` file for reference, apply via individual `--command` calls per the network workaround below — do not assume `--file` works)
- [ ] Bill payment endpoints (`src/routes/bills.js`) + UI page (`public/bills.html`, follow the pattern of `uploads.html`)
- [ ] Loan application endpoints (`src/routes/loans.js`, auto-approve <$2k, manual review ≥$2k) + UI page with live monthly payment calculator
- [ ] Investment endpoints (`src/routes/investments.js`, 4 plans) + UI page with projected return calculator
- [ ] External transfer endpoint (5 mock banks) + batch transfer endpoint (extend `src/routes/transfers.js`)
- [ ] Transaction history endpoint (filter/search/sort/paginate) + Transactions UI page — will need a seed script for ~80-100 mock transactions spanning 6 months (follow the `scripts/generate-seed.mjs` pattern)
- [ ] Wire up the currently-disabled dashboard quick-action buttons (Pay Bills / Apply for Loan / Invest) once their pages exist
- [ ] Update this file's endpoint/schema/phase sections as you go, same level of detail as Phase 1

### Phase 3 — Statements, Cards, Notifications
- [ ] `pdf-lib` integration (`bun add pdf-lib` — first non-trivial dependency in this project, verify it bundles fine with `wrangler deploy`); generate statement PDFs, store in R2 (`statements/{userId}/{statementId}.pdf`)
- [ ] CSV export (simple string-building, no library)
- [ ] Statements UI page + statement history list
- [ ] `cards` table + endpoints (view/block/unblock) + Cards UI section
- [ ] `notifications` table + endpoints + UI notification area
- [ ] `audit_logs` table + endpoint + UI viewer in Profile page
- [ ] Account freeze/unfreeze UI wiring (`POST /api/accounts/:id/freeze` etc. — endpoints not yet built either)

### Phase 4 — Security Showcase Layer
- [ ] Implement all 10 intentional vulnerabilities from the OWASP mapping table above, on clearly separate/isolated endpoints
- [ ] Verify WAF/content-scanning test surfaces work as intended
- [ ] Write `openapi-schema.yaml` (OpenAPI 3.0) covering all **legitimate** endpoints only — deliberately exclude the shadow `/api/v1` endpoint so it shows up as a "shadow API" in API Discovery
- [ ] `test-api.sh` — happy-path validation script for all real endpoints
- [ ] `attack-simulation.sh` — exercises each intentional vulnerability
- [ ] Finalize `README.md` / `DOCUMENTATION.txt` / `API_REFERENCE.md`

### Phase 5 — Optional Stretch
- [ ] mTLS protection for `/api/internal/*` routes
- [ ] Custom domain setup (`banking.puregroundscoffee.com`)
- [ ] Configure API Shield in Cloudflare dashboard: upload OpenAPI schema, enable BOLA/rate-limit/JWT validation features, run attack simulations end-to-end

---

## Current Cloudflare Resources Already Provisioned
- Worker: `banking` — production at `banking.davidrecla.workers.dev`, GitHub-connected via Workers Builds, production branch `main`. Non-production branches also auto-build and get their own preview URL (format: `https://{version-id-prefix}-banking.davidrecla.workers.dev`, findable via `wrangler versions list` or the "Checks" tab on a GitHub PR).
- D1: `bank-database` (id `6f12dd90-3093-4b25-adcb-a0e43ece88ac`), binding `BANK_DB` — schema applied (`users`, `accounts`, `transactions`, `uploads`), seeded with 5 demo users + 15 accounts.
- KV: `BANK_KV` (id `fa8bcc19366b4f68ac9c3ff6ebf54a0b`) — rate-limit counters.
- R2: `bank-bucket`, binding `BANK_BUCKET` — user uploads (Phase 1); will also store generated statements (Phase 3).
- Secret: `JWT_SECRET` set directly on the `banking` Worker (48 random bytes, base64-encoded). Not in any file — fetch/rotate via `wrangler secret put JWT_SECRET` if ever needed.

---

## Local Environment Notes (read before running any Wrangler/D1/GitHub commands)

These are things that cost real debugging time this session — check here first if something inexplicably fails.

1. **`wrangler d1 execute --file=...` fails with a generic `fetch failed` error on this network.** The file-upload-based ingestion path (used internally by `--file`) hits a different Cloudflare endpoint than direct `--command` queries, and that path fails here (likely network/proxy related — a "corporate proxy/VPN" warning is shown, though no proxy env vars are actually set). **Workaround:** always split SQL into individual statements and run each via `wrangler d1 execute --remote --command="..."`. Both `scripts/generate-seed.mjs` and `scripts/update-passwords.mjs` already do this (they emit a `.ps1` file of individual `--command` calls, not a single `.sql` file to upload). Follow this same pattern for any new schema/data changes.

2. **`curl.exe` on Windows sometimes fails TLS with `CRYPT_E_NO_REVOCATION_CHECK`** when hitting `*.workers.dev` from this network. Fix: add `--ssl-no-revoke` to the curl command.

3. **Windows environment variables set via `setx` (or any registry change, incl. installer PATH updates) are not picked up by already-running processes** — including this Devin CLI session's own background shell host. If you `setx` something new (e.g. an API token) and a command still can't see it, the fix is to fully quit and restart the Devin CLI / IDE application (not just close a terminal window) so its process relaunches and inherits the fresh environment. This was needed for both `CLOUDFLARE_API_TOKEN` and the `gh` CLI PATH entry.

4. **`wrangler dev --remote` prints a `self-signed certificate in certificate chain` warning/error for the `Request.cf` object fetch.** This is benign/cosmetic in this environment — the dev server still starts and works correctly (verified via multiple successful `wrangler dev --remote` test sessions). Don't treat it as a blocker.

5. **Local Wrangler auth:** `CLOUDFLARE_API_TOKEN` is set as a persistent Windows user env var. Verify with `npx wrangler whoami`. If it ever shows "Not logged in," the token may have been cleared — see note 3 above about needing a full app restart after any `setx`.

6. **GitHub CLI (`gh`) is installed** at `C:\Program Files\GitHub CLI\gh.exe` (may not be on PATH in every shell — same PATH-refresh caveat as note 3; use the full path if `gh` alone isn't found) and authenticated as `davidrecla` via `gh auth login --web`. Use it for PR creation/merging: `gh pr create`, `gh pr checks <n>`, `gh pr merge <n> --merge`, etc., all with `--repo davidrecla/banking`.

7. **PowerShell + `curl.exe` quoting:** passing JSON bodies with escaped double-quotes inline (e.g. `-d '{\"key\":\"val\"}'`) is unreliable for POST bodies with complex nested content — it works for simple cases but failed for a multi-field transfer payload. If a curl command mysteriously returns "field X is required" for fields you did pass, switch to writing the JSON to a temp file via `ConvertTo-Json | Out-File -Encoding utf8` and use `curl --data "@file.json"` instead. Also note: `Out-File`/`>` redirection defaults to **UTF-16** on Windows PowerShell, which breaks tools expecting UTF-8 (e.g. this session's file-reading tool) — always pipe through `Out-File -Encoding utf8` explicitly when generating text files via PowerShell.

8. **Testing workflow used throughout Phase 1** (repeat this for Phase 2+): build on a feature branch → `wrangler dev --remote` locally (hits the real D1/KV/R2 + real JWT secret, not a local emulator) → test endpoints with curl → push branch → open PR (`gh pr create`) → wait for the Cloudflare Workers Builds check → find/test the preview URL (via `wrangler versions list` or the PR's Checks tab detail, which prints a `Preview URL:` line directly) → merge PR (`gh pr merge <n> --merge`) → verify production.
