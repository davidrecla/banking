-- Phase 3: Statements, cards, notifications, audit logs
--
-- NOTE: reference copy. Apply via
-- `node scripts/generate-schema.mjs schema/003_phase3.sql > scripts/schema-003.ps1`
-- and run the generated script -- `wrangler d1 execute --file` fails on this
-- network (BUILD-PLAN.md "Local Environment Notes" note 1).

CREATE TABLE IF NOT EXISTS statements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  format TEXT NOT NULL, -- pdf | csv
  date_range_start TEXT NOT NULL,
  date_range_end TEXT NOT NULL,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  linked_account_id TEXT NOT NULL REFERENCES accounts(id),
  card_type TEXT NOT NULL, -- debit | credit
  -- Only the masked forms are stored. There is no real PAN behind these, and
  -- Phase 4 must not introduce an endpoint that returns an unmasked number.
  card_number_masked TEXT NOT NULL,
  card_holder TEXT NOT NULL,
  expiry TEXT NOT NULL, -- MM/YY
  cvv_masked TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | blocked
  blocked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, -- transaction | security | account | promotion
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL, -- login | logout | transfer | bill_payment | card_block | account_freeze | statement_generate | ...
  detail TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_statements_user_id ON statements(user_id);
CREATE INDEX IF NOT EXISTS idx_cards_user_id ON cards(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
