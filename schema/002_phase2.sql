-- Phase 2: Extended banking features
-- Payees, bills, loans, investments, external/batch transfers
--
-- NOTE: this file is a reference copy. It is NOT applied via
-- `wrangler d1 execute --file=...`, which fails on this network (see
-- BUILD-PLAN.md "Local Environment Notes" note 1). Apply it with
-- `node scripts/generate-phase2-schema.mjs > scripts/phase2-schema.ps1`
-- and run the generated script, which issues one --command call per statement.

CREATE TABLE IF NOT EXISTS payees (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  bill_type TEXT NOT NULL, -- electricity | water | internet | mobile | credit_card | insurance
  account_number TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payee_id TEXT REFERENCES payees(id),
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  bill_type TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  amount REAL NOT NULL,
  due_date TEXT,
  memo TEXT,
  confirmation_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed', -- completed | pending | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  disburse_account_id TEXT REFERENCES accounts(id),
  amount REAL NOT NULL,
  term_months INTEGER NOT NULL,
  purpose TEXT,
  employment_status TEXT,
  annual_income REAL,
  interest_rate REAL NOT NULL,
  monthly_payment REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review', -- approved | pending_review | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS investments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  plan_type TEXT NOT NULL, -- money_market | balanced_fund | growth_equity | fixed_deposit
  amount REAL NOT NULL,
  duration_months INTEGER NOT NULL,
  annual_rate REAL NOT NULL,
  projected_return REAL NOT NULL,
  maturity_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | withdrawn
  withdrawn_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- External transfers are recorded here as well as in `transactions`, because
-- they carry destination-bank detail that has nowhere to live on a transaction
-- row. Internal transfers keep using `transactions` alone.
CREATE TABLE IF NOT EXISTS transfers (
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
  reference_number TEXT NOT NULL,
  batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed', -- completed | pending | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payees_user_id ON payees(user_id);
CREATE INDEX IF NOT EXISTS idx_bills_user_id ON bills(user_id);
CREATE INDEX IF NOT EXISTS idx_loans_user_id ON loans(user_id);
CREATE INDEX IF NOT EXISTS idx_investments_user_id ON investments(user_id);
CREATE INDEX IF NOT EXISTS idx_transfers_user_id ON transfers(user_id);
CREATE INDEX IF NOT EXISTS idx_transfers_batch_id ON transfers(batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
