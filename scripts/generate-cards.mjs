// Generates a PowerShell script of `wrangler d1 execute --command=...` calls
// seeding two cards per demo user: a debit card linked to their checking
// account and a credit card linked to their savings account.
//
// Run: node scripts/generate-cards.mjs <accounts.json> > scripts/cards-seed.ps1
// Then execute the generated .ps1 against the remote D1 database.
//
// Produce accounts.json first (note the extra columns this script needs):
//   npx wrangler d1 execute bank-database --remote --json \
//     --command="SELECT a.id, a.account_type, u.id AS user_id, u.username, u.full_name FROM accounts a JOIN users u ON u.id = a.user_id;" \
//     > scripts/accounts.json
//
// NO REAL CARD DATA. Only masked forms are generated and stored: the PAN is
// '**** **** **** NNNN' and the CVV is '***'. There is no full number behind
// them anywhere in the system, which is deliberate — a demo app should not
// carry anything that looks like live cardholder data, and Phase 4 should
// generate obviously-fake numbers on the fly if it wants a card-exposure
// vulnerability rather than persisting them now.
//
// Individual --command calls rather than a single --file, per BUILD-PLAN.md
// "Local Environment Notes" note 1. Seeded RNG so reruns are reproducible.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const accountsFile = process.argv[2];
if (!accountsFile) {
  console.error('Usage: node scripts/generate-cards.mjs <accounts.json>');
  console.error('See the header comment for the exact query to produce it.');
  process.exit(1);
}

let rngState = 77002026;
function rnd() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

const raw = JSON.parse(readFileSync(accountsFile, 'utf8'));
const accounts = (Array.isArray(raw) ? raw[0].results : raw.results) || [];
if (accounts.length === 0) {
  console.error('No accounts found in the provided file.');
  process.exit(1);
}
if (!accounts[0].full_name || !accounts[0].user_id) {
  console.error('accounts.json is missing user_id/full_name — re-run the query in this file\'s header.');
  process.exit(1);
}

const CARD_SPECS = [
  { cardType: 'debit', linkTo: 'checking' },
  { cardType: 'credit', linkTo: 'savings' }
];

function esc(str) {
  return String(str).replace(/'/g, "''");
}

function last4() {
  return String(Math.floor(1000 + rnd() * 9000));
}

function expiry() {
  const month = String(1 + Math.floor(rnd() * 12)).padStart(2, '0');
  // 2-4 years out, so nothing looks expired during a demo.
  const year = (new Date().getFullYear() + 2 + Math.floor(rnd() * 3)) % 100;
  return `${month}/${String(year).padStart(2, '0')}`;
}

function wranglerCmd(sql) {
  return `npx wrangler d1 execute bank-database --remote --command="${sql.replace(/"/g, '`"')}"`;
}

const lines = ['$env:CLOUDFLARE_ACCOUNT_ID="0feb844d7ff36330cdd00ed24797fe85"'];
const byUser = new Map();
for (const account of accounts) {
  if (!byUser.has(account.username)) byUser.set(account.username, []);
  byUser.get(account.username).push(account);
}

let count = 0;
for (const [username, userAccounts] of byUser) {
  for (const spec of CARD_SPECS) {
    const linked = userAccounts.find((a) => a.account_type === spec.linkTo);
    if (!linked) {
      console.error(`  skipped ${username} ${spec.cardType}: no ${spec.linkTo} account`);
      continue;
    }

    const sql =
      `INSERT INTO cards (id, user_id, linked_account_id, card_type, card_number_masked, card_holder, expiry, cvv_masked, status, created_at) ` +
      `VALUES ('${randomUUID()}', '${linked.user_id}', '${linked.id}', '${spec.cardType}', ` +
      `'**** **** **** ${last4()}', '${esc(linked.full_name.toUpperCase())}', '${expiry()}', '***', 'active', '${new Date().toISOString()}');`;

    lines.push(wranglerCmd(sql));
    count++;
  }
}

console.log(lines.join('\n'));
console.error(`${count} cards for ${byUser.size} users`);
