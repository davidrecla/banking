# PGC Bank Demo — Build Plan & Reference Spec

**Purpose:** Demo banking app on Cloudflare Workers, used to showcase **API Shield** and **WAF** (payload/content scanning) capabilities to a customer (Metrobank-style POC). Must have both a Web UI and a REST API, where every UI action maps to a documented API call.

**Base spec source:** `FUNCTIONALITY-SUMMARY.md` (original requirements doc), extended with security-showcase additions decided during planning.

---

## Architecture Decisions

| Concern | Decision | Reason |
|---|---|---|
| Primary data store | **D1** (`bank-database`, binding `BANK_DB`) | Relational data (users, accounts, transactions, loans, etc.) needs joins, filtering, and atomic multi-row writes (e.g. a transfer debits one account + credits another together) |
| Ephemeral / counters | **KV** (`BANK_KV`) | Rate-limit counters (login attempts/min, daily transfer totals), not relational |
| File storage | **R2** (`bank-bucket`, binding `BANK_BUCKET`) | Generated PDF/CSV statements, user-uploaded documents |
| JWT signing key | **Cloudflare Secret** (`JWT_SECRET`, via `wrangler secret put`) | Single static app-wide value — correct use of Secrets |
| User passwords | **Hashed in D1** (PBKDF2 + per-user random salt, via Web Crypto) | Passwords are per-user data needing lookups by username — Secrets can't do this; hashing avoids storing plaintext even for demo accounts |
| PDF generation | **`pdf-lib`** (pure JS, Workers-compatible) | No Node-specific APIs; Node PDF libs (pdfkit etc.) don't run in Workers runtime |

---

## Demo User Accounts & Password Scheme

Password = first initial of first name + last name (lowercase), **except admin** (kept as originally spec'd).

| Username | Full Name | Password (plaintext, pre-hash) | Role |
|---|---|---|---|
| chris.brown | Chris Brown | `cbrown` | Regular |
| sarah.j | Sarah Johnson | `sjohnson` | Premium |
| mike.d | Mike Davis | `mdavis` | Basic |
| emma.w | Emma Wilson | `ewilson` | VIP |
| admin | Admin User | `admin1` | Admin |

Each user gets 3 accounts (Savings, Checking, Investment), each seeded at **USD 3,000** (USD 9,000 total per user).

Passwords are hashed with PBKDF2 + unique per-user salt before being written to D1 in a one-time seed migration. Plaintext values above are only used transiently during seeding and are displayed on the demo login page as "demo credentials" (this is intentional — a real bank would never use this scheme).

---

## D1 Schema (draft — refine during Phase 1 implementation)

```sql
users (id, username, full_name, password_hash, salt, role, member_since, account_frozen, created_at)
accounts (id, user_id FK, account_type, account_number, balance, created_at)
transactions (id, account_id FK, type, amount, merchant, category, status, description, created_at)
transfers (id, from_account_id, to_account_id NULLABLE, external_bank NULLABLE, external_account_number NULLABLE, external_account_name NULLABLE, amount, note, fee, status, created_at)
bills (id, user_id FK, bill_type, payee_name, account_number, amount, due_date, confirmation_number, status, created_at)
payees (id, user_id FK, name, bill_type, account_number)
loans (id, user_id FK, amount, term_months, purpose, employment_info, income, interest_rate, monthly_payment, status, created_at)
investments (id, user_id FK, plan_type, amount, duration, projected_return, status, maturity_date, created_at)
cards (id, user_id FK, card_number_masked, expiry, cvv_masked, status, linked_account_id FK)
notifications (id, user_id FK, type, message, read, created_at)
audit_logs (id, user_id FK, event_type, ip_address, device_info, created_at)
statements (id, user_id FK, account_id NULLABLE, format, date_range_start, date_range_end, r2_key, created_at)
uploads (id, user_id FK, filename, content_type, size, r2_key, uploaded_at)
```

KV keys (not D1):
- `ratelimit:login:{username}` — login attempt counter (5/min)
- `ratelimit:transfer:{userId}:{date}` — daily transfer total ($1000/day cap)

---

## Full Endpoint List (grouped by phase)

### Auth
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`

### Accounts
- `GET /api/accounts`
- `GET /api/accounts/:id`
- `POST /api/accounts/:id/freeze`
- `POST /api/accounts/:id/unfreeze`

### Transfers
- `POST /api/transfers/internal` ($500/txn, $1000/day cap)
- `POST /api/transfers/external` (5 mock banks, $1000/txn)
- `POST /api/transfers/batch`

### Bills
- `GET /api/bills/payees`
- `POST /api/bills/payees`
- `POST /api/bills/pay` ($2000/txn cap)
- `GET /api/bills`

### Loans
- `POST /api/loans/apply` ($500–$10k, auto-approve <$2k)
- `GET /api/loans`
- `GET /api/loans/:id`

### Investments
- `GET /api/investments/plans`
- `POST /api/investments` ($100–$5000)
- `GET /api/investments`
- `POST /api/investments/:id/withdraw`

### Transactions
- `GET /api/transactions` (filter/search/sort/paginate)
- `GET /api/transactions/:id`

### Statements
- `POST /api/statements/generate` (PDF via pdf-lib, or CSV)
- `GET /api/statements`
- `GET /api/statements/:id/download` (serves from R2)

### Cards
- `GET /api/cards`
- `POST /api/cards/:id/block`
- `POST /api/cards/:id/unblock`

### Notifications
- `GET /api/notifications`
- `POST /api/notifications/:id/read`

### Uploads (NEW — for content/malware scanning testing)
- `POST /api/uploads` — multiple files per user, **no type/size restrictions** (intentional, so you can test WAF Content Scanning against varied payloads incl. EICAR test file)
- `GET /api/uploads`
- `GET /api/uploads/:id` (download)
- `DELETE /api/uploads/:id`

### Security / Ops
- `GET /api/audit-log`
- `GET /api/usage` (rate limit/quota display)

---

## Intentional Vulnerabilities (mapped to OWASP API Security Top 10)

| OWASP API # | Category | Endpoint | Vulnerability |
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

## WAF / Content Scanning Test Surfaces
- File uploads (no restrictions) — test with **EICAR test string** (safe, industry-standard fake-malware test file) to validate malware/content scanning
- Free-text fields (transfer notes, bill memos, loan purpose) — left unfiltered client-side so payloads reach the edge for WAF managed rule (SQLi/XSS) testing
- `POST /api/transfers/batch` — oversized JSON body to test body-size limits

## Optional Stretch Goal
- **mTLS** on `/api/internal/*` routes (contrast with the intentionally-missing-auth `/api/internal/debug`) to demo API Shield's mTLS client-cert authentication

---

## Build Phases

### Phase 1 — Foundation (BUILD THIS FIRST) — ✅ COMPLETE (on branch `phase-1-foundation`, not yet merged to `main`)
- [x] D1 schema migration: `users`, `accounts`, `transactions`, `uploads` tables (`schema/001_phase1_initial.sql`)
- [x] `JWT_SECRET` set as Cloudflare Worker secret
- [x] Password hashing utility (PBKDF2 + per-user salt) + seed script for 5 demo users + their 3 accounts each (`src/lib/crypto.js`, `scripts/generate-seed.mjs`)
- [x] Auth endpoints: login (JWT, 24h expiry), refresh, logout (`src/routes/auth.js`)
- [x] `GET /api/accounts`, `GET /api/accounts/:id` (`src/routes/accounts.js`)
- [x] `POST /api/transfers/internal` with $500/txn + $1000/day limits via KV counter (`src/routes/transfers.js`)
- [x] Upload endpoints (`POST/GET/:id/DELETE /api/uploads`) using R2, no restrictions (`src/routes/uploads.js`)
- [x] Basic UI: Login page (demo credentials shown), Dashboard (balance cards, internal transfer form), Documents/Uploads page (`public/*.html`, `public/app.js`, `public/styles.css`), served via Workers Assets

All Phase 1 endpoints tested end-to-end against the real (remote) D1/KV/R2 resources via `wrangler dev --remote` — login, wrong-password rejection, unauthenticated rejection, internal transfer (success + over-limit rejection), and upload/list/download/delete all verified working.

**Known issue / workaround:** `wrangler d1 execute --file=...` fails with a generic `fetch failed` error on this network (the file-upload-based ingestion path hits a different endpoint than direct `--command` queries, which work fine). Workaround: split schema/seed SQL into individual statements and run each via `wrangler d1 execute --remote --command="..."` instead of `--file`. This is what `scripts/generate-seed.mjs` does (it emits a `.ps1` of individual `--command` calls rather than a single `.sql` file to upload).

### Phase 2 — Extended Banking Features
- [ ] D1 schema additions: `bills`, `payees`, `loans`, `investments`
- [ ] Bill payment endpoints + UI page
- [ ] Loan application endpoints (auto-approve <$2k, manual review ≥$2k) + UI page with live monthly payment calculator
- [ ] Investment endpoints (4 plans) + UI page with projected return calculator
- [ ] External transfer endpoint (5 mock banks) + batch transfer endpoint
- [ ] Transaction history endpoint (filter/search/sort/paginate, ~80-100 seeded mock transactions) + Transactions UI page

### Phase 3 — Statements, Cards, Notifications
- [ ] `pdf-lib` integration; generate statement PDFs, store in R2 (`statements/{userId}/{statementId}.pdf`)
- [ ] CSV export (simple string-building, no library)
- [ ] Statements UI page + statement history list
- [ ] `cards` table + endpoints (view/block/unblock) + Cards UI section
- [ ] `notifications` table + endpoints + UI notification area
- [ ] `audit_logs` table + endpoint + UI viewer in Profile page
- [ ] Account freeze/unfreeze UI wiring

### Phase 4 — Security Showcase Layer
- [ ] Implement all 10 intentional vulnerabilities from the OWASP mapping table above
- [ ] Verify WAF/content-scanning test surfaces work as intended (uploads, free-text fields, oversized payloads)
- [ ] Write `openapi-schema.yaml` (OpenAPI 3.0) covering all **legitimate** endpoints — deliberately exclude the shadow `/api/v1` endpoint
- [ ] `test-api.sh` — happy-path validation script for all real endpoints
- [ ] `attack-simulation.sh` — exercises each intentional vulnerability
- [ ] Finalize `README.md` / `DOCUMENTATION.txt` / `API_REFERENCE.md`

### Phase 5 — Optional Stretch
- [ ] mTLS protection for `/api/internal/*` routes
- [ ] Custom domain setup (`banking.puregroundscoffee.com`)
- [ ] Configure API Shield in Cloudflare dashboard: upload OpenAPI schema, enable BOLA/rate-limit/JWT validation features, run attack simulations end-to-end

---

## Current Cloudflare Resources Already Provisioned
- Worker: `banking` (deployed at `banking.davidrecla.workers.dev`, GitHub-connected via Workers Builds, production branch `main`)
- D1: `bank-database` (id `6f12dd90-3093-4b25-adcb-a0e43ece88ac`), binding `BANK_DB` — schema applied (`users`, `accounts`, `transactions`, `uploads`), seeded with 5 demo users + 15 accounts ($3000 each, $45,000 total)
- KV: `BANK_KV` (id `fa8bcc19366b4f68ac9c3ff6ebf54a0b`) — used for rate-limit counters
- R2: `bank-bucket`, binding `BANK_BUCKET` — used for user uploads (Phase 1) and will store generated statements (Phase 3)
- Secret: `JWT_SECRET` set on the `banking` Worker (48 random bytes, base64-encoded)

## Repo/Workflow Notes
- Repo: `davidrecla/banking` on GitHub
- `main` = production branch (auto-deploys via `wrangler deploy` on push)
- Non-production branches also build (via `wrangler versions upload`), each getting its own preview URL — visible in GitHub PR checks under "Cloudflare Workers and Pages"
- Local Wrangler is authenticated via `CLOUDFLARE_API_TOKEN` env var (user-level, set via `setx`)
