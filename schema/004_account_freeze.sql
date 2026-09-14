-- Phase 3: per-account freeze flag
--
-- `users.account_frozen` already existed from Phase 1 but is user-wide and
-- unused. The freeze endpoints are per-account (POST /api/accounts/:id/freeze),
-- so the flag belongs on accounts. users.account_frozen is left in place rather
-- than dropped, since Phase 4's intentionally-vulnerable endpoints may want a
-- user-level flag to expose.
--
-- Apply via:
--   node scripts/generate-schema.mjs schema/004_account_freeze.sql > scripts/schema-004.ps1
-- then run the generated script (see BUILD-PLAN.md note 1).

ALTER TABLE accounts ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0;
