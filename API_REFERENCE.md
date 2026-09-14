# PGC Bank — API Reference

Base URLs: `https://banking.puregroundscoffee.com` /
`https://banking.davidrecla.workers.dev`

All endpoints are JSON over HTTPS unless noted. Protected endpoints require
`Authorization: Bearer <jwt>` from `POST /api/auth/login`. Tokens carry
`sub` (user id), `username` and `role` claims, HS256-signed, 24h expiry.

Error shape: `{ "error": "<message>" }` with a 4xx/5xx status. CORS is wide open
(demo).

Machine-readable version: [openapi-schema.yaml](openapi-schema.yaml) (OpenAPI
3.0, legitimate endpoints only).

---

## Authentication (public)

### POST /api/auth/login
`{ username, password }` → `{ token, expiresIn, user }`.
Rate-limited to 5 attempts/minute per username (429 beyond that); bad and good
attempts both count. Unknown usernames and wrong passwords return the same
401 message.

### POST /api/auth/refresh
`{ token }` → `{ token, expiresIn }` if the old token is still valid.

### POST /api/auth/logout
Stateless no-op → `{ message }`. (JWTs are not blacklisted in this demo.)

---

## Profile

### GET /api/profile
The caller's profile record.

---

## Accounts

### GET /api/accounts
→ `{ accounts: [{ id, account_type, account_number, balance, frozen, created_at }] }`
Scoped to the caller; each demo user holds savings + checking + investment.

### GET /api/accounts/:id
Ownership-checked single account → `{ account }`. Other users' ids 404.

### POST /api/accounts/:id/freeze · POST /api/accounts/:id/unfreeze
→ `{ message, account: { id, frozen } }`. A freeze is enforced across every
debit path (`loadDebitableAccount`): transfers, bills and investment purchases
403; credits (deposits, disbursements, incoming transfers) still succeed.
Repeat calls 400.

---

## Transactions

### GET /api/transactions
Query params: `accountId`, `type` (deposit | withdrawal | transfer_in |
transfer_out | bill_payment | loan_payment | investment_purchase), `category`,
`search` (merchant/description substring), `minAmount`, `maxAmount`, `from`,
`to` (inclusive; bare dates cover the whole day), `sort` (created_at | amount |
type | merchant | category — whitelisted), `order`, `limit` (1–100, default 25),
`offset`.

→ `{ transactions, pagination: { total, limit, offset, hasMore } }`

Always scoped to the caller by joining through accounts.

### GET /api/transactions/:id
Ownership-checked → `{ transaction }`.

---

## Transfers

### POST /api/transfers/internal
`{ fromAccountId, toUsername, toAccountType, amount, note? }`
Caps: **$500/txn, $1000/day** (KV-backed rolling counters). Writes a
`transfer_out`/`transfer_in` double-entry pair in one batch. →
`{ message, from: { accountId, newBalance }, to }`.

### POST /api/transfers/external
`{ fromAccountId, bankCode, accountNumber, accountName, amount, note? }`
Caps: **$1000/txn + flat $2.50 fee**, amount + fee debited together →
`{ transfer: { id, bank, referenceNumber, ... }, newBalance }` (201).

### POST /api/transfers/batch
`{ fromAccountId, transfers: [...] }` — max 10 items, all-or-nothing (every
item validated and the combined total incl. fees checked before any write).
Errors name the offending index. Items share a `batch_id`.

### GET /api/transfers/banks
→ `{ banks: [{ code, name }], maxPerTransaction, fee }` — FNB, MTB, PCU, SVB, HRZ.

### GET /api/transfers
External/batch history with reference numbers.

---

## Bills

### GET /api/bills/payees · POST /api/bills/payees · DELETE /api/bills/payees/:id
Saved payees. Create body: `{ name, billType, accountNumber }`;
`billType` = electricity | water | internet | mobile | credit_card |
insurance. Detaching payees does not rewrite payment history (bills keep
copied payee details).

### POST /api/bills/pay
`{ fromAccountId, amount, payeeId? | (payeeName + billType + accountNumber), dueDate?, memo? }`
**$2000/txn cap.** When `payeeId` is given, the stored payee's details win
over anything else in the body. Debit + ledger row + bill row in one batch →
`{ bill: { id, confirmationNumber, ... }, newBalance }` (201).

### GET /api/bills
Payment history, newest first, with confirmation numbers (`PGC-XXXXXX`).

---

## Loans

### POST /api/loans/apply
`{ amount, termMonths, purpose?, employmentStatus?, annualIncome?, disburseAccountId? }`
**$500–$10,000**; terms 6/12/24/36/48/60 months. Rate by term: 5.5% (≤12mo) →
9.5% (60mo).

- **Under $2000:** auto-approved and disbursed immediately — `disburseAccountId`
  required; account credited + deposit ledger row.
- **$2000 and above:** `pending_review`, nothing disbursed.

### GET /api/loans · GET /api/loans/:id
The caller's loans (ownership-checked for the single-loan view).

---

## Investments

### GET /api/investments/plans
Four plans: `money_market` 3.25% [3/6/12mo], `fixed_deposit` 4.5% [6/12/24mo],
`balanced_fund` 6.75% [12/24/36mo], `growth_equity` 9.5% [12/36/60mo].
Plus `minAmount` ($100) / `maxAmount` ($5000).

### POST /api/investments
`{ fromAccountId, planType, amount, durationMonths }` — duration validated per
plan. Debits the funding account; `projectedReturn` uses simple interest.

### GET /api/investments
Holdings with resolved plan names.

### POST /api/investments/:id/withdraw
Pays into the original funding account. Before maturity returns principal only;
at/after maturity returns the projected value. Double withdraw 400s.

---

## Cards

### GET /api/cards
The caller's cards joined to the linked account. **Only masked values exist**
(`**** **** **** NNNN`, `***`) — there is no full PAN or CVV anywhere.

### POST /api/cards/:id/block · POST /api/cards/:id/unblock
Ownership-checked; repeat calls 400.

---

## Statements

### POST /api/statements/generate
`{ accountId, from, to, format? }` — format `pdf` (default) | `csv`. Renders
the file, stores it in R2 (`statements/{userId}/{id}.{ext}`), records a row,
and returns period totals. Period balances are derived from the ledger, not
`accounts.balance`, so consecutive windows chain. → 201.

### GET /api/statements · GET /api/statements/:id/download
List (newest first) / download stream with correct Content-Type and
Content-Disposition. Ownership-checked.

---

## Notifications

### GET /api/notifications
Query: `unreadOnly=true`, `limit` (1–100, default 50). Always returns
`unreadCount` alongside rows. Notifications go to who the event concerns: an
incoming transfer notifies the recipient.

### POST /api/notifications/:id/read
No-op success on an already-read notification (clients can race themselves).

### POST /api/notifications/read-all
→ `{ message, updated }`.

---

## Audit log

### GET /api/audit-log
Query: `eventType`, `limit` (1–100, default 50), `offset`. →
`{ entries, eventTypes, pagination }`. Entries capture CF-Connecting-IP and the
user agent; `eventTypes` lists only values the caller actually has. Scoped to
the caller.

Event types: `login`, `login_failed`, `logout`, `transfer_internal`,
`transfer_external`, `transfer_batch`, `bill_payment`, `loan_application`,
`investment_purchase`, `investment_withdraw`, `card_block`, `card_unblock`,
`account_freeze`, `account_unfreeze`, `statement_generate`, plus the Phase 4
showcase action types `transfer_express` and `loan_force_approve`.

---

## Uploads

### POST /api/uploads
`multipart/form-data` with a `file` field. **No type/size restrictions by
design** — this is the WAF content-scanning test surface. Stores in R2 under
`uploads/{userId}/{id}-{filename}` → `{ id, filename, contentType, size }` (201).

### GET /api/uploads · GET /api/uploads/:id · DELETE /api/uploads/:id
List (metadata), download (raw stream from R2, ownership-checked), delete
(R2 object + metadata row together).

---

## Phase 4 showcase endpoints (intentionally vulnerable — DO NOT integrate)

These exist only for the Cloudflare security demo, are absent from the OpenAPI
schema, and must not appear in the UI or be "fixed" in app code:

| Endpoint | Deliberate flaw (OWASP) |
|---|---|
| `GET /api/internal/debug` | No authentication; dumps users incl. password hashes (API2) |
| `GET /api/users/:userId/balance` | No ownership check (API1, BOLA) |
| `GET /api/profile?internal=1` | Undocumented param flips to full-record mode (API3; base response also leaks hash/salt) |
| `POST /api/transfers/express` | No rate limiting (API4) |
| `GET /api/admin/users` · `POST /api/admin/loans/:id/force-approve` | No role checks (API5, BFLA); force-approve disburses pending loans |
| `POST /api/profile/avatar-from-url` | Unvalidated server-side fetch (API7, SSRF) |
| `POST /api/debug/parse` | Malformed JSON returns 500 with a JS stack trace (API8) |
| `GET /api/v1/accounts` | Deprecated shadow endpoint, undocumented, verbose rows + `?userId=` override (API9) |

(API6 — Unrestricted Access to Sensitive Business Flows — reuses the existing
`POST /api/loans/apply` / `POST /api/investments`, which have no per-day
frequency caps.)
