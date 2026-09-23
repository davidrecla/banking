# PGC Bank Demo — Build Plan & Reference Spec

**Purpose:** Demo banking app on Cloudflare Workers, used to showcase **API Shield** and **WAF** (payload/content scanning) capabilities to a customer (Metrobank-style POC). Must have both a Web UI and a REST API, where every UI action maps to a documented API call.

**Base spec source:** `FUNCTIONALITY-SUMMARY.md` (original requirements doc, in the user's Downloads folder, not part of this repo), extended with security-showcase additions decided during planning.

**Status: Phases 1, 1.5, 2, 3 and 4 are complete and live in production.** Phase 4 shipped: the 9 intentionally vulnerable endpoints (`src/routes/vulnerable.js`), `openapi-schema.yaml` (legit endpoints only), `test-api.sh`, `attack-simulation.sh`, and final docs (README, DOCUMENTATION.txt, API_REFERENCE.md). What remains for the demo is **Cloudflare zone configuration, not repo work**: upload the schema, create the rules listed in the Phase 4 matrix, run both scripts end-to-end. Read this whole file before starting; in particular read "Things Phase 3 established that later phases must respect" and the WAF note under Phase 4, both of which change how Phase 4 should be built.

---

## Quick Orientation (read this first)

- **Live production URLs:** https://banking.puregroundscoffee.com (custom domain, declared as a `[[routes]]` entry in `wrangler.toml`) and https://banking.davidrecla.workers.dev (kept live alongside it)
- **Page routing:** `/` is the public marketing homepage, `/login` is the login form, `/dashboard` and `/uploads` are the authenticated pages. Note `/` was the login page until the homepage was added — `app.js` redirects unauthenticated/logged-out users to `/login`, not `/`.
- **GitHub repo:** `davidrecla/banking` (branch `main` = production, auto-deploys via Cloudflare Workers Builds on every push)
- **Cloudflare Worker name:** `banking`, account "Pure Grounds Coffee Co." (account ID `0feb844d7ff36330cdd00ed24797fe85`)
- **Workflow:** commit and push directly to `main` — the user's standing instruction (2026-09-22) is that "sync to GitHub" always means straight to `main`, no feature branches or PRs. Mind the consequence: every push auto-deploys to production via Workers Builds, so dry-run/test Worker-affecting changes first. Branches/PRs only if explicitly requested.
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
│   ├── index.html              # Public marketing homepage (served at /)
│   ├── login.html              # Login page (served at /login)
│   ├── dashboard.html          # Balances, quick actions, internal transfer form, recent transactions
│   ├── transactions.html       # Transaction history: filter/search/sort/paginate (served at /transactions)
│   ├── bills.html              # Pay bills + manage saved payees (/bills)
│   ├── loans.html              # Loan application with live payment calculator (/loans)
│   ├── investments.html        # Plan cards, purchase with return calculator, withdraw (/investments)
│   ├── transfers.html          # External + batch transfers to mock banks (/transfers)
│   ├── statements.html         # Generate/download PDF + CSV statements (/statements)
│   ├── cards.html              # Cards with block/unblock + account freeze controls (/cards)
│   ├── profile.html            # User details, notifications, security activity log (/profile)
│   ├── uploads.html            # Documents/file upload page
│   ├── app.js                  # Shared client helpers: auth token storage, authFetch(), toasts, formatCurrency()
│   └── styles.css              # DBS-inspired styling (see "UI Design" section below)
├── schema/
│   └── 001_phase1_initial.sql # D1 schema (users, accounts, transactions, uploads) — reference copy; actually applied via individual --command calls, see below
├── scripts/
│   ├── generate-seed.mjs      # Generates .ps1 of wrangler d1 execute --command calls to seed 5 demo users + 15 accounts
│   ├── update-passwords.mjs   # Generates .ps1 of UPDATE statements to change existing users' passwords (used when password scheme changed post-seed)
│   ├── generate-schema.mjs         # Emits .ps1 applying any schema/*.sql one statement at a time
│   ├── generate-transactions.mjs   # Emits .ps1 seeding ~95 mock transactions over 6 months AND the balances they imply (needs an accounts.json dump; see its header)
│   ├── generate-cards.mjs          # Emits .ps1 seeding 2 masked cards per demo user (needs accounts.json with user_id/full_name)
│   └── generate-activity.mjs       # Emits .ps1 seeding audit entries + notifications (needs users.json; never implies money movement)
├── wrangler.toml               # Worker config: bindings (D1/KV/R2/Assets), no secrets here (JWT_SECRET is a real Cloudflare secret)
├── package.json
└── BUILD-PLAN.md               # This file
```

Generated files are gitignored (regenerate via their `.mjs` source if needed): `scripts/seed-commands.ps1`, `scripts/update-passwords-commands.ps1`, `scripts/schema-*.ps1`, `scripts/transactions-seed.ps1`, `scripts/cards-seed.ps1`, `scripts/activity-seed.ps1`, `scripts/r2-cleanup.ps1`, `scripts/accounts.json`, `scripts/users.json`.

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
| PDF generation (Phase 3, built) | **`pdf-lib`** `^1.17.1` (pure JS, Workers-compatible) | No Node-specific APIs; Node PDF libs (pdfkit etc.) don't run in Workers runtime. Verified generating a valid parseable PDF on the real edge, not just bundling |
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

Each user has 3 accounts (Savings, Checking, Investment). Each account **opens** at USD 3,000 via a visible "Opening balance" deposit, but the **current balance is whatever the seeded transaction history produces** (roughly $1.6k–$9.3k per account) — because the ledger reconciles against the balance. See "The ledger reconciles" under Phase 2 below. Do not assume balances are a flat $3,000.

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

## D1 Schema — Phase 2 additions (applied and live)

Reference copy in `schema/002_phase2.sql`. Applied via `node scripts/generate-phase2-schema.mjs > scripts/phase2-schema.ps1` and running that script (one `--command` per statement — see note 1).

```sql
CREATE TABLE payees (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  bill_type TEXT NOT NULL, -- electricity | water | internet | mobile | credit_card | insurance
  account_number TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payee_id TEXT REFERENCES payees(id),        -- NULL for one-off payments
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  bill_type TEXT NOT NULL,
  payee_name TEXT NOT NULL,                   -- copied, so deleting a payee doesn't rewrite history
  account_number TEXT NOT NULL,               -- likewise
  amount REAL NOT NULL,
  due_date TEXT,
  memo TEXT,
  confirmation_number TEXT NOT NULL,          -- display-only, e.g. PGC-4F2A9C
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE loans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  disburse_account_id TEXT REFERENCES accounts(id),  -- NULL if never disbursed
  amount REAL NOT NULL,
  term_months INTEGER NOT NULL,
  purpose TEXT,
  employment_status TEXT,                     -- employed | self_employed | contract | retired | student
  annual_income REAL,
  interest_rate REAL NOT NULL,
  monthly_payment REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review', -- approved | pending_review | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE investments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  plan_type TEXT NOT NULL,                    -- money_market | fixed_deposit | balanced_fund | growth_equity
  amount REAL NOT NULL,
  duration_months INTEGER NOT NULL,
  annual_rate REAL NOT NULL,
  projected_return REAL NOT NULL,
  maturity_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',      -- active | withdrawn
  withdrawn_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- External transfers are recorded here AS WELL AS in `transactions`, because
-- destination-bank detail has nowhere to live on a transaction row. Internal
-- transfers still use `transactions` alone.
CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  to_account_id TEXT REFERENCES accounts(id),
  external_bank TEXT,
  external_account_number TEXT,
  external_account_name TEXT,
  amount REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  note TEXT,
  reference_number TEXT NOT NULL,             -- display-only, e.g. TRF-8KD2M4XP
  batch_id TEXT,                              -- shared by all items of one batch; NULL for single
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- plus indexes on payees.user_id, bills.user_id, loans.user_id,
-- investments.user_id, transfers.user_id, transfers.batch_id,
-- transactions.created_at
```

## D1 Schema — Phase 3 additions (applied and live)

Reference copies in `schema/003_phase3.sql` and `schema/004_account_freeze.sql`. Applied via `node scripts/generate-schema.mjs <file> > scripts/schema-00N.ps1` and running the generated script.

```sql
statements (id, user_id FK, account_id FK, format, date_range_start,
            date_range_end, transaction_count, r2_key, size_bytes, created_at)

cards (id, user_id FK, linked_account_id FK, card_type, card_number_masked,
       card_holder, expiry, cvv_masked, status, blocked_at, created_at)
  -- masked values ONLY; no full PAN or CVV exists anywhere (see point 5 above)

notifications (id, user_id FK, type, title, message, read, created_at)
  -- type: transaction | security | account | promotion

audit_logs (id, user_id FK, event_type, detail, ip_address, user_agent, created_at)

ALTER TABLE accounts ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0;
  -- schema 004. Phase 1's users.account_frozen is user-wide and unused; it was
  -- left in place rather than dropped, in case Phase 4 wants it.

-- plus indexes on statements.user_id, cards.user_id, notifications.user_id,
-- notifications(user_id, read), audit_logs.user_id, audit_logs.created_at
```

### Planned additions for later phases (not yet created)
None — all tables from the original spec now exist. Phase 4 adds endpoints, not tables.

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

## API Endpoints — Phase 2 (implemented and live)

Implemented in `src/routes/transactions.js`, `bills.js`, `loans.js`, `investments.js` and (extended) `transfers.js`. All require `Authorization: Bearer <jwt>`.

### Transaction history
- `GET /api/transactions` — query params: `accountId`, `type`, `category`, `search` (merchant/description substring), `minAmount`, `maxAmount`, `from`, `to`, `sort` (`created_at|amount|type|merchant|category`), `order` (`asc|desc`), `limit` (1-100, default 25), `offset`. Returns `{ transactions, pagination: { total, limit, offset, hasMore } }`.
  - **Always scoped to the caller** by joining through `accounts` on `user_id` — passing another user's `accountId` returns zero rows, not their data.
  - `sort` resolves through a **whitelist map**, since column names can't be bind parameters. Unknown keys 400.
- `GET /api/transactions/:id` — ownership-checked single transaction.
- ~90 mock transactions spanning 6 months are seeded via `scripts/generate-transactions.mjs` (see below).

### Bills
- `GET /api/bills/payees`, `POST /api/bills/payees` (body `{ name, billType, accountNumber }`), `DELETE /api/bills/payees/:id`.
- `POST /api/bills/pay` — body `{ fromAccountId, amount, payeeId? | (payeeName + billType + accountNumber), dueDate?, memo? }`. **$2000/txn cap.** When `payeeId` is given, the stored payee's details take precedence over anything passed alongside it (so a caller can't reference a saved payee while redirecting the money).
- `GET /api/bills` — payment history with confirmation numbers.
- The debit, the `transactions` row and the `bills` row are written in one `batch()`.

### Loans
- `POST /api/loans/apply` — body `{ amount, termMonths, purpose?, employmentStatus?, annualIncome?, disburseAccountId? }`. **$500–$10,000**, terms 6/12/24/36/48/60 months.
  - **Under $2000: auto-approved and disbursed immediately** — credits the account and writes a `deposit` ledger row, so `disburseAccountId` is required.
  - **$2000 and above: `pending_review`, disburses nothing.**
  - Account ownership is validated even when not disbursing, so a pending loan can't be filed against someone else's account.
- `GET /api/loans`, `GET /api/loans/:id` (ownership-checked).
- Rate by term: ≤12mo 5.5%, ≤24mo 6.5%, ≤36mo 7.5%, ≤48mo 8.5%, else 9.5%. `interestRateFor()` and `monthlyPaymentFor()` are **exported and duplicated verbatim in `public/loans.html`** so the live calculator matches what the server records. **If you change one, change both.**

### Investments
- `GET /api/investments/plans` — the four plans: `money_market` 3.25% (low, 3/6/12mo), `fixed_deposit` 4.5% (low, 6/12/24mo), `balanced_fund` 6.75% (medium, 12/24/36mo), `growth_equity` 9.5% (high, 12/36/60mo).
- `POST /api/investments` — body `{ fromAccountId, planType, amount, durationMonths }`. **$100–$5000**; `durationMonths` is validated **per plan**, not globally. Debits the funding account.
- `GET /api/investments` — holdings, with `plan_name` resolved from the plan table.
- `POST /api/investments/:id/withdraw` — pays into the original funding account. **Before maturity returns principal only**; at/after maturity returns `projected_return`. Withdrawing twice is rejected.
- `projectedReturnFor()` is likewise mirrored in `public/investments.html`.

### Transfers (external + batch)
- `GET /api/transfers/banks` — the 5 mock banks (`FNB` First National, `MTB` Metro Trust, `PCU` Pacific Credit Union, `SVB` Summit Valley, `HRZ` Horizon Financial) plus the cap and fee, so the UI doesn't hardcode them.
- `POST /api/transfers/external` — body `{ fromAccountId, bankCode, accountNumber, accountName, amount, note? }`. **$1000/txn cap, flat $2.50 fee**; amount + fee are debited together.
- `POST /api/transfers/batch` — body `{ fromAccountId, transfers: [{ bankCode, accountNumber, accountName, amount, note? }] }`, **max 10 items**. **All-or-nothing:** every item is validated before any write, and the combined total *including fees* is checked against the balance up front, so a bad entry mid-list can't leave a partially-applied batch. Errors name the offending index (`transfers[1]: ...`). Items share a `batch_id`.
- `GET /api/transfers` — external/batch history with reference numbers.

## API Endpoints — Phase 3 (implemented and live)

Implemented in `src/routes/statements.js`, `cards.js`, `notifications.js`, `audit.js` and (extended) `accounts.js`. All require `Authorization: Bearer <jwt>`.

### Statements
- `POST /api/statements/generate` — body `{ accountId, from, to, format? }`, `format` = `pdf` (default) or `csv`. Renders the file, stores it in R2 at `statements/{userId}/{statementId}.{ext}`, records a `statements` row, and returns the period totals.
- `GET /api/statements` — the caller's statements, newest first.
- `GET /api/statements/:id/download` — streams the stored file from R2 with the right `Content-Type`/`Content-Disposition`. Ownership-checked.
- Both formats are built from **one shared dataset function**, so the PDF and CSV can never disagree about the numbers. Only settled rows count toward totals. See point 2 above on period balances.

### Cards
- `GET /api/cards` — masked card details joined to the linked account.
- `POST /api/cards/:id/block`, `POST /api/cards/:id/unblock` — ownership-checked; a no-op repeat returns 400 rather than silently succeeding.

### Account freeze
- `POST /api/accounts/:id/freeze`, `POST /api/accounts/:id/unfreeze` — see point 1 above; this is enforced across every debit path, not just a flag. `GET /api/accounts` now returns `frozen`.

### Notifications
- `GET /api/notifications` — query params `unreadOnly=true`, `limit` (1-100, default 50). Always returns `unreadCount` alongside the rows so a nav badge needs no second request.
- `POST /api/notifications/:id/read` — marking an already-read notification is a no-op success, since a client can race itself.
- `POST /api/notifications/read-all` — **registered before the `/:id/read` pattern** so `"read-all"` is never parsed as an id.
- Notifications go to whoever the event concerns, not whoever triggered it: an internal transfer notifies the **recipient**.

### Audit log
- `GET /api/audit-log` — query params `eventType`, `limit` (1-100, default 50), `offset`. Returns entries, the caller's distinct `eventTypes` (so the UI filter only offers values that return something), and pagination. Scoped to the caller.

### Planned for later phases (not yet implemented)
```
GET  /api/usage                     — Phase 4/5 (API usage metrics)
```

---

## UI Design (Phase 1, implemented)

Redesigned to look like a real bank (originally had a generic Cloudflare-purple gradient look, replaced per instruction). Templated loosely after DBS Bank's site (https://www.dbs.com.sg):
- Red: `#d81f1f` (primary CTA color, accents). **Was `#FF3333`, changed because that value reads as orange rather than red.** Do not reintroduce `#FF3333`.
- Black: `#000000` (top nav, headers)
- White: `#FFFFFF` (page background/cards)
- Gray `#484848` for secondary text

**The palette is centralized and must stay that way.** All colors are CSS custom properties in the single `:root` block at the top of `public/styles.css` (`--dbs-red`, `--dbs-red-dark`, `--dbs-red-focus`, `--dbs-red-tint`, `--dbs-black`, `--dbs-gray`, `--dbs-gray-light`, `--dbs-border`), and that one stylesheet serves every page. Inline SVG icons use `fill="currentColor"`/`stroke="currentColor"` and inherit the red from CSS (`.icon-badge`/`.hero-art` set `color: var(--dbs-red)`) — **do not hardcode hex colors in markup or SVG attributes**, or a future brand-color change stops being a one-line edit.

Design conventions used (see `public/styles.css`, CSS variables at the top):
- Black top nav bar with a red bottom border accent
- White cards with a red top border accent (`.balance-card`, `.login-card`)
- Red primary buttons (`.btn-primary`), black "danger" buttons (`.btn-danger`, used for Logout)
- No emoji icons anywhere (previously had 🏦💰💳 etc. — removed for a more professional/bank-like look)
- No demo credentials displayed on the login page (removed — they live only in this file now)

Pages: `index.html` (public marketing homepage at `/`), `login.html` (login form at `/login`), `dashboard.html` (balances, quick actions, internal transfer form, 5 most recent transactions), `transactions.html`, `bills.html`, `loans.html`, `investments.html`, `transfers.html`, `uploads.html` (Documents page: upload/list/download/delete files).

**All dashboard quick actions are now wired up** (Transfer Money, Send to Another Bank, Pay Bills, Apply for Loan, Invest) — no disabled Phase 2 placeholders remain.

Phase 2 added these shared CSS component classes to `styles.css`, all built from the same `:root` tokens — reuse them rather than inventing new ones: `.filter-grid`/`.filter-actions`/`.btn-inline` (filter panels), `.txn-table` + `th.sortable` (sortable tables), `.status-pill` + `.status-completed|pending|failed`, `.amount-credit`/`.amount-debit`, `.pagination-bar`, `.calc-panel`/`.calc-item`/`.calc-label`/`.calc-value` (live calculators), `.plan-grid`/`.plan-card`/`.risk-low|medium|high`, `.batch-row`. Green `#1a7f37` for credits and amber `#8a5a00` for pending are the only colors outside the red/black/white palette, used solely for financial/status semantics.

The homepage is modeled loosely on Metrobank's homepage (https://www.metrobank.com.ph/home): hero with CTA, a row of quick-action tiles, a feature-highlights section, and a footer. **Its nav/tile/footer links other than "Login" are deliberately inert** (`onclick="return false;"`) because the features behind them don't exist yet — wire them to real pages as those get built in Phase 2/3. The Login links (top nav, hero CTA, footer) point at `/login`.

`public/app.js` has shared helpers used by all pages: `getToken()`/`setSession()`/`getUser()`/`clearSession()` (localStorage-based), `requireAuth()` (redirects to `/` if not logged in), `authFetch()` (fetch wrapper that auto-attaches the Bearer token and redirects to login on 401), `formatCurrency()`, `showToast()`.

**Important UI convention to maintain in later phases:** every UI action must call the same public REST API — no UI-only logic that bypasses the API. This is a hard requirement from the original spec (so all UI functionality is exercisable/testable via direct API calls too, which matters for the API Shield demo).

---

## Intentional Vulnerabilities (Phase 4, NOT yet implemented) — mapped to OWASP API Security Top 10

API10 (Unsafe Consumption of 3rd-Party APIs) was considered and **dropped** during
design: blindly-trusting the mock external bank's response is an origin-side logic
flaw with no edge-side Cloudflare mitigation, so it produced no "after" block to
demo. The nine vulnerabilities below were each designed so the attack input is
visible at the edge (request shape, JWT claims, rate, or path inventory), giving
every one a **deterministic, on-camera Cloudflare block** in the "after" run.

| OWASP API # | Category | Endpoint (planned) | Vulnerability | Exploit (for `attack-simulation.sh`) | Cloudflare block in the "after" run |
|---|---|---|---|---|---|
| API1 | Broken Object Level Authorization (BOLA) | `GET /api/users/:userId/balance` | Any authenticated user can view another user's balance (no ownership check) | Log in as `chris.brown`, loop `userId` across all 5 users, dump balances | **WAF rate limiting rule** on `/api/users/*/balance` — enumeration is inherently high-rate from one session, so it 429s deterministically. Show Sequence Analytics tracing the enumeration alongside; do NOT promise the ML `cf-risk-bola-enumeration` label live (needs 10,000+ sessions) |
| API2 | Broken Authentication | `GET /api/internal/debug` | No authentication required; exposes user list, password hashes, internal config | Plain `curl`, no token → full data | **JWT validation rule** with `is_jwt_present()` → Block on `/api/internal/*`. Phase 5 adds **mTLS** on the same path for contrast |
| API3 | Excessive Data Exposure | `GET /api/profile` | Base response already leaks `password_hash`/`salt`/internal flags; an `?internal=1`-style query param flips it into full-record mode | (a) diff the base response vs. UI fields; (b) probe `GET /api/profile?internal=1` | **Schema validation** declares `/profile` with no query params → the probe is a schema violation → Block. The leaky base response stays as the "fix the app" talking point — the edge cannot redact response bodies |
| API4 | Unrestricted Resource Consumption | `POST /api/transfers/express` | No rate limiting applied (unlike legit `/api/transfers/internal`, which uses the KV limiter) | 50 transfer POSTs in ~2s, all succeed | **WAF rate limiting rule** on the path — exactly the edge equivalent of the KV limiter this endpoint skips |
| API5 | Broken Function Level Authorization (BFLA) | `GET /api/admin/users`, `POST /api/admin/loans/:id/force-approve` | No role check — regular users can call admin-only functions | Regular user's token calls both admin endpoints → 200s | Two layered blocks shown back-to-back: (1) **schema fallthrough rule** — `/api/admin/*` ops aren't in the uploaded OpenAPI schema → blocked as unknown operations; (2) **JWT validation custom rule** on `http.request.jwt.claims.role != "admin"` → Block. Requires the `role`-claim JWT change below |
| API6 | Unrestricted Access to Sensitive Business Flows | `POST /api/loans/apply` / `POST /api/investments` | No cap on applications per day per user | 100 loan applications from one user in a minute | Manual **rate limiting rule** on loans/investments POSTs (deterministic). Mention **Volumetric Abuse Detection** as the ML version, with its 50-sessions/24h warmup caveat — do not rely on it live |
| API7 | Server-Side Request Forgery (SSRF) | `POST /api/profile/avatar-from-url` | Worker fetches a user-supplied URL server-side with no validation | Body `"url": "http://169.254.169.254/latest/meta-data"` → Worker fetches and returns the body | **Schema validation with an allowlist pattern on the URL field** (`^https://cdn\.puregroundscoffee\.com/…`) → the metadata URL is a schema violation → Block before the Worker ever fetches. Backup: custom rule matching private-IP strings in the request body. Residual-risk note stays in the pitch: the definitive SSRF fix is origin-side allowlisting |
| API8 | Security Misconfiguration | any JSON endpoint with malformed body (`/api/auth/login` as the demo target) | Verbose 500 leaks stack traces / raw D1 error text on type-confused input | POST type-confused JSON (array/object mismatch) → 500 with stack trace | Same malformed body on the "after" run: **schema validation strict typing** rejects it with a clean 400 at the edge — the error surface never exists because garbage never reaches the Worker |
| API9 | Improper Inventory Management | `GET /api/v1/accounts` | Deprecated, undocumented shadow endpoint still live, absent from the OpenAPI schema | Straight `curl` works silently | **API Discovery** (ML + session-identifier-based) surfaces `/api/v1/accounts` as an unmanaged candidate operation → **fallthrough rule** then blocks everything not in the uploaded schema. Flagship demo |

### JWT `role` claim — one auth change that unlocks two demos

`src/routes/auth.js` must add a `role` claim to the JWT payload at login (the
`users.role` column already exists). This is what makes API5's JWT-claims custom
rule (and API1's layered defense story) evaluable at the edge. It also makes the
JWT a suitable session-identifier source for API Shield (`sub` claim).

### Deterministic blocks vs. ML detections — demo honestly

Two Cloudflare features have traffic floors a live demo cannot meet: BOLA
enumeration risk labels (10,000+ sessions) and Volumetric Abuse Detection rate
recommendations (50+ distinct sessions in 24h). The scriptable, deterministic
blockers above — schema validation + fallthrough rule, JWT validation rules,
rate limiting rules, managed WAF rules, mTLS — are the live-demo backbone;
position the ML features as "what production sees over weeks."

### Entitlements — VERIFIED on the account

- **Zone plan: Enterprise** (`puregroundscoffee.com`, id `43dd610e196766bc22f86638e1f087c4`).
- **WAF malicious uploads detection: enabled** on the zone (the EICAR block lives zone-side; the only blocker is this machine's own Gateway egress policy).
- **API Shield endpoints respond** for the zone (schema upload + operations API work — schema 91d2a8e1 and 41 endpoint-management ops are uploaded/synced).

### Zone configuration is staged, scripted, and idempotent

`scripts/demo-edge-config.py` (sync/arm/disarm/status) owns all six "PGC demo:"
edge rules plus schema validation's action: fallthrough block, unauthenticated
internal-debug block, content-scan block, query-string block on /api/profile,
and three rate-limit rules (BOLA enumeration, express burst, loan/investment
spam). Verified end-to-end: arm → after-run 11/11 BLOCKED with legitimate
traffic unaffected; disarm → before-run 11/11 VULNERABLE. **Leave the zone
disarmed between rehearsals.** Optional-not-required extra: native API Shield
JWT validation (role-claim rule) needs the JWT secret pasted in the dashboard —
the staged custom rules cover the demo without it.

**Do not implement these until Phase 4**, and only on separate, clearly-named
endpoints — keep them isolated from the legitimate API surface so the
"before/after API Shield" story stays clean for the demo. Per Phase 3 note 5:
no real card PANs persist anywhere — if an exploit step needs card-shaped data,
generate obviously-fake numbers on the fly.

### Cloudflare WAF already blocks some attacks before they reach the Worker

Observed during Phase 2 testing: a SQLi-shaped query string (`?sort=amount;DROP+TABLE+users`) returned **403 from Cloudflare's WAF at the edge** — the request never reached the Worker. Encouraging for the WAF half of the demo, but it has a direct consequence for Phase 4: **`attack-simulation.sh` cannot assume its payloads will reach the app.** Some attacks will be blocked upstream, which is great for the "after" story but means the "before" (vulnerable) demonstration may need managed rules relaxed, a bypass rule for the demo hostname, or attacks shaped to slip past pattern matching. Decide that deliberately when writing Phase 4 rather than discovering it mid-demo.

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
- [x] Password hashing (PBKDF2 + per-user salt) + seed script; 5 demo users × 3 accounts × $3000 seeded (balances later became ledger-derived in Phase 2 — see "The ledger reconciles")
- [x] Auth endpoints: login (JWT, 24h expiry, rate-limited), refresh, logout
- [x] `GET /api/accounts`, `GET /api/accounts/:id`
- [x] `POST /api/transfers/internal` with $500/txn + $1000/day limits
- [x] Upload endpoints (`POST/GET/:id/DELETE /api/uploads`) via R2, no restrictions
- [x] Basic UI (login, dashboard, documents pages), DBS-inspired redesign, no demo creds shown in UI
- [x] Merged via PR #3 into `main`; verified live at https://banking.davidrecla.workers.dev

### Phase 1.5 — Public homepage + custom domain — ✅ COMPLETE
- [x] Public marketing homepage at `/` (`public/index.html`), Metrobank-inspired structure, DBS-style theme
- [x] Login form moved to `/login` (`public/login.html`); `app.js` redirects (`requireAuth()`, `authFetch()` 401 handler, `logout()`) updated to `/login`
- [x] Brand red changed `#FF3333` -> `#d81f1f`; palette fully centralized in `:root`, SVGs switched to `currentColor`
- [x] Merged via PR #4 into `main`
- [x] Custom domain `banking.puregroundscoffee.com` declared in `wrangler.toml` as a `[[routes]]` entry with `custom_domain = true`

### Phase 2 — Extended Banking Features — ✅ COMPLETE AND MERGED TO MAIN (live in production)
Delivered as four PRs so each stayed independently reviewable: #8 schema + transactions, #9 bills, #10 loans + investments, #11 external/batch transfers.
- [x] D1 schema additions: `payees`, `bills`, `loans`, `investments`, `transfers` (+ indexes) — `schema/002_phase2.sql`, applied via `scripts/generate-phase2-schema.mjs`
- [x] Bill payment endpoints (`src/routes/bills.js`) + `public/bills.html` — $2000/txn cap, saved payees, confirmation numbers
- [x] Loan application endpoints (`src/routes/loans.js`, auto-approve <$2k and disburse, manual review ≥$2k) + `public/loans.html` with live monthly payment calculator
- [x] Investment endpoints (`src/routes/investments.js`, 4 plans) + `public/investments.html` with projected return calculator and withdrawal
- [x] External transfer endpoint (5 mock banks, $1000/txn, $2.50 fee) + all-or-nothing batch transfer endpoint (extended `src/routes/transfers.js`) + `public/transfers.html`
- [x] Transaction history endpoint (filter/search/sort/paginate) + `public/transactions.html`; 95 mock transactions over 6 months seeded via `scripts/generate-transactions.mjs`, with balances derived from the history so the ledger reconciles
- [x] Wired up every dashboard quick-action button
- [x] Updated this file's endpoint/schema/phase sections

**Post-Phase-2 data baseline.** Phase 2 was tested against live D1, then cleaned up and reseeded. Verified state: **95** transactions (15 opening deposits + 80 activity rows), 86 completed / 5 pending / 4 failed, 14 categories, 7 types, spanning ~6 months; `loans`/`investments`/`transfers`/`bills`/`payees` all **empty**; no negative balances. Balances are **no longer** a flat $3000 — they are whatever the ledger produces (roughly $1.6k–$9.3k). If a future session's counts differ, that is leftover test data rather than seed data.

### The ledger reconciles — keep it that way

**Invariant: for every account, `balance == sum(completed credits) - sum(completed debits)`**, where credits are `deposit`/`transfer_in` and debits are everything else. Verified across all 15 accounts in live D1.

This was not true originally: the first version of `generate-transactions.mjs` wrote random rows and never touched balances, so adding up the history did not produce the displayed balance — the kind of thing a customer notices immediately in a banking demo. `scripts/generate-transactions.mjs` now simulates the run chronologically instead:

- Each account opens with a visible **$3000 "Opening balance" deposit** (category `opening`), so the history fully explains the balance.
- Debits that would overdraw an account are **skipped**, so no balance goes negative.
- Transfers between demo users are written as **real double-entry pairs** — a `transfer_out` on the source and a matching `transfer_in` on the destination with the same amount and timestamp. Cross-checking two demo accounts shows both halves (verified 10/10).
- Rows with status `pending` or `failed` deliberately **do not** move the balance, mirroring how a real ledger treats unsettled entries. Statuses are assigned on a fixed cadence rather than by random draw, because a random draw once produced zero `pending` rows and left that status pill undemonstrable.
- The RNG is seeded from a constant (`SEED` in the script) so re-running produces identical data and demos stay reproducible.

**If you reseed, re-check the invariant** with the query in the PR that introduced this (`fix/reconciling-ledger`), or simply re-derive it: group `transactions` by `account_id`, sum completed credits minus completed debits, compare to `accounts.balance`. Any future feature that moves money must write its ledger row in the same `batch()` as the balance update — as bills, loans, investments and transfers all already do — or this invariant silently breaks.

### Phase 3 — Statements, Cards, Notifications — ✅ COMPLETE AND MERGED TO MAIN (live in production)
Delivered as three PRs: #14 statements + schema + lockfile, #15 cards + enforced freeze + UI, #16 notifications + audit log.
- [x] `pdf-lib` integration — statement PDFs stored in R2 (`statements/{userId}/{statementId}.pdf`)
- [x] CSV export (hand-built, RFC 4180 quoting, no library)
- [x] Statements UI page (`public/statements.html`) + statement history list
- [x] `cards` table + endpoints (view/block/unblock) + `public/cards.html`; 10 cards seeded via `scripts/generate-cards.mjs`
- [x] `notifications` table + endpoints + notification area on the Profile page, with an unread badge in the dashboard nav
- [x] `audit_logs` table + endpoint + viewer on `public/profile.html`
- [x] Account freeze/unfreeze endpoints **and enforcement** (`accounts.frozen`, schema 004)

**Post-Phase-3 data baseline** (verified after cleanup): **95** transactions reconciling against all 15 account balances; `bills`/`loans`/`investments`/`transfers`/`statements` all **empty**; **10** cards, all active; **40** audit entries and **15** notifications (seeded); no frozen accounts. R2 holds no statement objects.

### Things Phase 3 established that later phases must respect

1. **A freeze is enforced, not a flag.** Every path that debits an account loads it through `loadDebitableAccount()` in `src/lib/accounts.js`, which 403s frozen accounts. Credits are deliberately still allowed, so money can arrive but not leave. **Any new money-moving endpoint must use that helper**, or a freeze silently becomes decorative again. Verified: internal, external and batch transfers, bill payments and investment purchases are all refused on a frozen account, while loan disbursement, incoming transfers and statement generation still work.

2. **Statement period balances come from the ledger, never from `accounts.balance`.** The opening balance sums everything that settled *before* the window and closing is opening + net, so consecutive periods chain (verified: Mar–Jun closes at 2854.82, Jul-onward opens at 2854.82). Reading the current balance as the closing balance — which the first implementation did — is only correct when the window happens to cover all history.

3. **Audit entries are written by the actions themselves**, so the log is real evidence rather than a viewer over an empty table: `login`, `login_failed`, `logout`, `transfer_internal`, `transfer_external`, `transfer_batch`, `bill_payment`, `loan_application`, `investment_purchase`, `investment_withdraw`, `card_block`, `card_unblock`, `account_freeze`, `account_unfreeze`, `statement_generate`. Each captures `CF-Connecting-IP` and the user agent. **Logging is best-effort and deliberately outside the caller's `batch()`** — a completed transfer must never fail because a log insert did, and batching them would let a logging failure roll back money movement.

4. **Seeded audit entries must never imply money movement.** `scripts/generate-activity.mjs` only seeds session/security/document events, because an entry claiming a payment with no matching transaction row would contradict the reconciling ledger. Money-movement entries appear only when someone really performs the action.

5. **Cards store only masked values.** `'**** **** **** NNNN'` and `'***'` — there is no full PAN or CVV anywhere in the system, and that is intentional. If Phase 4 wants a card-data-exposure vulnerability, generate obviously-fake numbers on the fly at that point rather than persisting realistic ones now.

6. **Bundle size is now worth watching.** `pdf-lib` took the Worker from ~47 KiB to ~900 KiB raw / ~230 KiB gzipped. Still well inside Workers' limits, but a second heavy dependency deserves a check.

7. **A lockfile is now committed.** `package-lock.json` is tracked, so CI installs a pinned graph and the deployed artifact is reproducible. `npm audit` reports 0 vulnerabilities.

### Phase 4 — Security Showcase Layer — ✅ COMPLETE (repo work; zone config remaining)
- [x] Vulnerable endpoints live in `src/routes/vulnerable.js` and are routed in `src/index.js` — all deliberately isolated under their own paths so the legitimate API surface is untouched. Verified live with `wrangler dev --remote`: every exploit succeeds (debug dump, BOLA enumeration, `?internal=1`, rapid express transfers, BFLA list + force-approve incl. a $3000 payout, SSRF fetch + body exfiltration, stack-trace leak incl. server file paths, shadow `v1/accounts`). API8's demo target is `POST /api/debug/parse` (isolated) instead of `/api/auth/login`, so the real login endpoint stays clean.
- [x] `role` claim at login — **already present** since Phase 1 (`{ sub, username, role }`), no change needed; the JWT validation claims rules for API5/API1 work against today's tokens
- Two new audit event types come from the vulnerable actions: `transfer_express` and `loan_force_approve` (Phase 3 note 3's list is the legitimate set)
- **Post-endpoint-build test state in D1:** chris.brown has one approved $3000 loan (applied pending_review, then force-approved via the API5b endpoint during verification) and sent $3 to sarah.johnson via express transfers. The ledger invariant still holds. These are intentional demo props — the attack script can create fresh ones, so re-running the "before" leg does not depend on this specific loan
- [x] Verify WAF/content-scanning test surfaces — SQLi probe covered by the app's own sort whitelist (400) with the edge 403 already field-proven in Phase 2; EICAR upload blocked client-side by the machine's Gateway policy (see script notes — demo from a clean network); the oversized-batch-body 413 demo depends on the zone plan tier (Free/Pro 100 MB) and is a live-demo step rather than something to rehearse from this network
- [x] `openapi-schema.yaml` (OpenAPI 3.0.3, verified parseable, 37 paths, all internal refs resolve) covering all **legitimate** endpoints only — the shadow `/api/v1/accounts` and every other vulnerable endpoint are deliberately excluded so the fallthrough rule works and API Discovery has a finding
- [x] `test-api.sh` — happy-path contract check of all legitimate endpoints (39 checks, read-mostly with self-cleaning mutations; run at demo start and end to prove legit traffic survives). It immediately caught a real Phase 2 bug on its first run: deleting a saved payee 500'd once any bill referenced it (`bills.payee_id` FK is enforced by D1) — fixed by NULLing the referencing rows in the same batch as the delete.
- [x] `attack-simulation.sh` — exercises each intentional vulnerability with `before`/`after` verdict modes (the same script is both demo acts; damage contained by construction). Verified "before" run against production: all 9 vulnerabilities succeed, incl. the $3000 force-approve fraud and a 20-transfer burst. Two environment findings: (a) the SQLi probe now 400s from the app's own sort whitelist — the Phase 2-era 403 came from managed rules blocking before the app saw it, and with rules in their current zone state the app handles it; (b) the EICAR upload is intercepted by a **client-side Cloudflare Gateway policy** on the demo machine's egress (302 to `blocked.teams.cloudflare.com`) before it leaves the network — that's the local network's SWG, not the zone's content scanning; demo malicious-uploads detection from a clean network/device or after adjusting that Gateway policy.
- [x] Finalize `README.md` / `DOCUMENTATION.txt` / `API_REFERENCE.md`

### Phase 5 — Demo Weaponization & Edge Configuration — ✅ COMPLETE
The demo/attack tooling built in the final sessions (originally scattered across Phase 4 notes and "stretch" items) is now formally Phase 5:
- [x] Cloudflare edge fully configured **as code** via `scripts/demo-edge-config.py` (sync/arm/disarm/status): OpenAPI schema uploaded as **`openapi-schema`** (`282cf3ce`), endpoint-management ops synced, six "PGC demo:" rules staged (fallthrough, unauth internal-debug, malicious-uploads content scan, profile query-string, two rate limits — the express-burst rule counts per Authorization header value, upgraded in-dashboard 2026-09-23; the BOLA enumeration rule was removed the same day, no longer showcased), schema validation action toggled log↔block. Idempotent; never touches non-"PGC demo:" zone rules. **Caveat learned 2026-09-23:** deleting/replacing a schema cascades-delete its synced Endpoint Management ops — after any schema replacement, re-run `sync` or Web Assets goes empty for the affected host. The tool also reports (but never modifies) three always-on zone protections: **leaked credential detection** (Security → Settings), the user-owned zone-wide **`Leaked Credentials Rule`** custom rule (blocks `cf.waf.credential_check.username_and_password_leaked` — Cloudflare's replacement for the deprecated Exposed Credentials Check managed ruleset, which was removed from this zone 2026-09-22), and the dashboard-deployed **Sensitive Data Detection** managed ruleset.
- [x] Full end-to-end demo execution verified against production twice: before-run 11/11 VULNERABLE, after-run 11/11 BLOCKED, legitimate traffic unaffected while armed, disarm restores baseline.
- [x] `POC-ATTACK-GUIDE.html` — the meeting artifact, rebuilt for the Metrobank POC: two tabs (macOS pre-demo setup; attack use cases UC-1..UC-5 ordered by POC-plan use case, 2 attacks each). The POC plan itself lives in Google Drive — link in AGENTS.md.
- [x] Non-API attack legs added to the demo: exposed-credential check, sensitive-data detection framing, and a homepage upload widget exercising content scanning against a real R2 write.
- [x] Custom domain setup (`banking.puregroundscoffee.com`) — done early, see Phase 1.5
- Entitlements verified: zone is Enterprise, content scanning enabled, API Shield APIs responsive

### Phase 6 — Optional (not in original scope)
- [ ] mTLS protection for `/api/internal/*` routes (contrast with the intentionally-missing-auth `/api/internal/debug`) — needs per-client certificates distributed to run it
- [ ] Native API Shield JWT validation (edge signature + role-claim rules) — needs the JWT secret pasted in a Token Configuration; the staged custom rules already cover the same demo moments

---

## Current Cloudflare Resources Already Provisioned
- Worker: `banking` — production at `banking.puregroundscoffee.com` (custom domain) and `banking.davidrecla.workers.dev`, GitHub-connected via Workers Builds, production branch `main`.
- Zone: `puregroundscoffee.com` is an active zone in this same Cloudflare account, which is what makes the custom domain possible. The `[[routes]]` entry with `custom_domain = true` creates the DNS record and TLS cert automatically on deploy. Non-production branches also auto-build and get their own preview URL (format: `https://{version-id-prefix}-banking.davidrecla.workers.dev`, findable via `wrangler versions list` or the "Checks" tab on a GitHub PR).
- D1: `bank-database` (id `6f12dd90-3093-4b25-adcb-a0e43ece88ac`), binding `BANK_DB` — schema applied (`users`, `accounts`, `transactions`, `uploads`), seeded with 5 demo users + 15 accounts.
- KV: `BANK_KV` (id `fa8bcc19366b4f68ac9c3ff6ebf54a0b`) — rate-limit counters. Plus `banking-BANK_KV_preview` (id `5870aa99099a4e6a99ed8301ec90df68`), used only by `wrangler dev` via `preview_id`.
- R2: `bank-bucket`, binding `BANK_BUCKET` — user uploads (`uploads/{userId}/...`) and generated statements (`statements/{userId}/{statementId}.{pdf|csv}`). Plus `bank-bucket-preview`, used only by `wrangler dev` via `preview_bucket_name`. **Note both buckets accumulate statements during testing** — `wrangler dev --remote` writes to the preview bucket while a deployed preview URL writes to production, so a cleanup pass has to clear both.
- Tooling: Wrangler is pinned to **4.x** in `package.json` (`^4.131.1`). It was on `^3.72.0`; the upgrade was required to make `wrangler dev --remote` work on this network and also cleared all 6 `npm audit` advisories (`npm audit` now reports 0).
- Secret: `JWT_SECRET` set directly on the `banking` Worker (48 random bytes, base64-encoded). Not in any file — fetch/rotate via `wrangler secret put JWT_SECRET` if ever needed.

---

## Local Environment Notes (read before running any Wrangler/D1/GitHub commands)

These are things that cost real debugging time this session — check here first if something inexplicably fails.

1. **`wrangler d1 execute --file=...` fails with a generic `fetch failed` error on this network.** The file-upload-based ingestion path (used internally by `--file`) hits a different Cloudflare endpoint than direct `--command` queries, and that path fails here (likely network/proxy related — a "corporate proxy/VPN" warning is shown, though no proxy env vars are actually set). **Workaround:** always split SQL into individual statements and run each via `wrangler d1 execute --remote --command="..."`. Both `scripts/generate-seed.mjs` and `scripts/update-passwords.mjs` already do this (they emit a `.ps1` file of individual `--command` calls, not a single `.sql` file to upload). Follow this same pattern for any new schema/data changes.

2. **`curl.exe` on Windows sometimes fails TLS with `CRYPT_E_NO_REVOCATION_CHECK`** when hitting `*.workers.dev` from this network. Fix: add `--ssl-no-revoke` to the curl command.

3. **Windows environment variables set via `setx` (or any registry change, incl. installer PATH updates) are not picked up by already-running processes** — including this Devin CLI session's own background shell host. If you `setx` something new (e.g. an API token) and a command still can't see it, the fix is to fully quit and restart the Devin CLI / IDE application (not just close a terminal window) so its process relaunches and inherits the fresh environment. This was needed for both `CLOUDFLARE_API_TOKEN` and the `gh` CLI PATH entry.

4. **`wrangler dev --remote` requires Wrangler 4 on this network, and preview resources for KV/R2.** This note previously claimed the `self-signed certificate in certificate chain` error was cosmetic. That was wrong: on Wrangler 3.x it is **fatal** here (TLS interception on this network kills the remote dev session with `Error while creating remote dev session: fetch failed`). Three separate things had to be fixed, all now in place:
   - `preview_id` for the KV namespace and `preview_bucket_name` for the R2 bucket in `wrangler.toml` — `wrangler dev` hard-refuses to start against production KV/R2 ids. Dev writes land in `banking-BANK_KV_preview` and `bank-bucket-preview`. (D1 only emits a *recommendation*, so dev deliberately still uses the real `bank-database` — that's what gives you the seeded demo users locally.)
   - **Wrangler 4.x** (now pinned in `package.json`). Wrangler 4 handles the intercepted TLS chain correctly and needs **no** `NODE_TLS_REJECT_UNAUTHORIZED=0` workaround — verified by running `wrangler dev --remote` with a clean environment and successfully authenticating against real D1. Do not reintroduce that env var; it disables TLS verification process-wide.
   - Note that once `[[routes]]` exists, Wrangler creates the remote preview session against the `puregroundscoffee.com` zone. That works with the current token; if it ever errors with `Could not create remote preview session`, check the token before assuming a network fault (`curl` the `/zones/{zone}/workers/edge-preview` endpoint — it should return an `exchange_url`).

5. **Local Wrangler auth:** `CLOUDFLARE_API_TOKEN` is set as a persistent Windows user env var. Verify with `npx wrangler whoami`. If it ever shows "Not logged in," the token may have been cleared — see note 3 above about needing a full app restart after any `setx`.

6. **GitHub CLI (`gh`) is installed** at `C:\Program Files\GitHub CLI\gh.exe` (may not be on PATH in every shell — same PATH-refresh caveat as note 3; use the full path if `gh` alone isn't found) and authenticated as `davidrecla` via `gh auth login --web`. Use it for PR creation/merging: `gh pr create`, `gh pr checks <n>`, `gh pr merge <n> --merge`, etc., all with `--repo davidrecla/banking`.

7. **PowerShell + `curl.exe` quoting:** passing JSON bodies with escaped double-quotes inline (e.g. `-d '{\"key\":\"val\"}'`) is unreliable for POST bodies with complex nested content — it works for simple cases but failed for a multi-field transfer payload. If a curl command mysteriously returns "field X is required" for fields you did pass, switch to writing the JSON to a temp file via `ConvertTo-Json | Out-File -Encoding utf8` and use `curl --data "@file.json"` instead. Also note: `Out-File`/`>` redirection defaults to **UTF-16** on Windows PowerShell, which breaks tools expecting UTF-8 (e.g. this session's file-reading tool) — always pipe through `Out-File -Encoding utf8` explicitly when generating text files via PowerShell.

8. **Adding a `[[routes]]` entry to `wrangler.toml` silently disables the `workers.dev` subdomain.** When the custom domain was added, `banking.davidrecla.workers.dev` immediately started returning 404 on every path — Wrangler defaults `workers_dev` to false as soon as any route is declared. The fix is an explicit `workers_dev = true` in `wrangler.toml` (now present — do not remove it, or the workers.dev URL dies again). Worth re-testing both hostnames after any routing/config change.

9. **Bare keys must precede all `[table]` headers in `wrangler.toml`.** TOML parses a bare key placed after a table header as belonging to *that table*, so `workers_dev = true` written below `[[routes]]` became a route field and failed the build with an unexpected-field error. Keep top-level settings (`name`, `main`, `compatibility_date`, `workers_dev`) grouped at the top of the file. **Run `npx wrangler deploy --dry-run` before pushing any `wrangler.toml` change** — it catches this class of error in seconds, versus a failed Workers Build after a push.

10. **Testing workflow used throughout Phase 1** (repeat this for Phase 2+): build on a feature branch → `wrangler dev --remote` locally (hits the real D1/KV/R2 + real JWT secret, not a local emulator) → test endpoints with curl → push branch → open PR (`gh pr create`) → wait for the Cloudflare Workers Builds check → find/test the preview URL (via `wrangler versions list` or the PR's Checks tab detail, which prints a `Preview URL:` line directly) → merge PR (`gh pr merge <n> --merge`) → verify production.
