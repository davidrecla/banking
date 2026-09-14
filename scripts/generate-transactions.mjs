// Generates a PowerShell script of `wrangler d1 execute --command=...` calls
// that seed ~90 mock transactions per demo user, spanning the last 6 months,
// so the Transactions page has realistic data to filter/search/sort/paginate.
//
// Run: node scripts/generate-transactions.mjs > scripts/transactions-seed.ps1
// Then execute the generated .ps1 against the remote D1 database.
//
// Individual --command calls rather than a single --file, per BUILD-PLAN.md
// "Local Environment Notes" note 1.
//
// Deliberately does NOT touch account balances. These rows are history for the
// UI to display; rewriting balances to match would desync the live balances
// that Phase 1 transfers already produced.
//
// Account ids are read from D1 at generation time rather than hardcoded:
//   npx wrangler d1 execute bank-database --remote --json \
//     --command="SELECT a.id, a.account_type, u.username FROM accounts a JOIN users u ON u.id = a.user_id;" \
//     > scripts/accounts.json
// then: node scripts/generate-transactions.mjs scripts/accounts.json

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const accountsFile = process.argv[2];
if (!accountsFile) {
  console.error('Usage: node scripts/generate-transactions.mjs <accounts.json>');
  console.error('See the header comment for how to produce accounts.json.');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(accountsFile, 'utf8'));
// `wrangler d1 execute --json` returns an array of result envelopes.
const accounts = (Array.isArray(raw) ? raw[0].results : raw.results) || [];
if (accounts.length === 0) {
  console.error('No accounts found in the provided file.');
  process.exit(1);
}

// [type, category, merchants[], amountRange]
const PATTERNS = [
  ['deposit', 'salary', ['PGC Payroll', 'Acme Corp Payroll', 'Freelance Invoice'], [1200, 3200]],
  ['deposit', 'refund', ['Amazon Refund', 'Airline Refund', 'Insurance Claim'], [15, 240]],
  ['withdrawal', 'groceries', ['FreshMart', 'Green Grocer', 'SuperSave', 'Corner Market'], [18, 180]],
  ['withdrawal', 'dining', ['Blue Fig Cafe', 'Nonna Pizzeria', 'Sushi Ten', 'Burger Yard'], [9, 95]],
  ['withdrawal', 'transport', ['Metro Transit', 'City Cabs', 'Shell Station', 'EV Charge Co'], [6, 85]],
  ['withdrawal', 'shopping', ['Uniqlo', 'Best Buy', 'IKEA', 'Zara'], [25, 420]],
  ['withdrawal', 'entertainment', ['Netflix', 'Spotify', 'Cinema 12', 'Steam'], [8, 60]],
  ['withdrawal', 'atm', ['ATM Withdrawal - Main St', 'ATM Withdrawal - Airport'], [40, 400]],
  ['bill_payment', 'utilities', ['City Power & Light', 'Metro Water Works', 'FiberNet'], [35, 210]],
  ['bill_payment', 'telecom', ['MobileOne Postpaid', 'CableVision'], [25, 130]],
  ['loan_payment', 'loan', ['PGC Bank Auto Loan', 'PGC Bank Personal Loan'], [180, 620]],
  ['investment_purchase', 'investment', ['PGC Money Market Fund', 'PGC Balanced Fund'], [200, 1500]],
  ['transfer_out', 'transfer', ['Chris Brown', 'Sarah Johnson', 'Mike Davis', 'Emma Wilson'], [20, 480]],
  ['transfer_in', 'transfer', ['Chris Brown', 'Sarah Johnson', 'Mike Davis', 'Emma Wilson'], [20, 480]]
];

const PER_ACCOUNT = 6; // 6 per account x 15 accounts = 90 rows
const MONTHS_BACK = 6;

function esc(str) {
  return String(str).replace(/'/g, "''");
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomAmount([min, max]) {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

function randomDateWithinMonths(months) {
  const now = Date.now();
  const earliest = now - months * 30 * 24 * 60 * 60 * 1000;
  return new Date(earliest + Math.random() * (now - earliest)).toISOString();
}

function wranglerCmd(sql) {
  const psEscaped = sql.replace(/"/g, '`"');
  return `npx wrangler d1 execute bank-database --remote --command="${psEscaped}"`;
}

const lines = ['$env:CLOUDFLARE_ACCOUNT_ID="0feb844d7ff36330cdd00ed24797fe85"'];

for (const account of accounts) {
  for (let i = 0; i < PER_ACCOUNT; i++) {
    const [type, category, merchants, range] = pick(PATTERNS);
    const merchant = pick(merchants);
    const amount = randomAmount(range);
    const createdAt = randomDateWithinMonths(MONTHS_BACK);
    // A small slice of rows are non-completed so status filtering has something
    // to show; the vast majority are completed, as in a real ledger.
    const status = Math.random() < 0.06 ? pick(['pending', 'failed']) : 'completed';
    // ASCII only: non-ASCII characters get mangled when PowerShell reads the
    // generated .ps1 (see BUILD-PLAN.md note 7 on encoding).
    const description = `${category} - ${merchant}`;

    const sql =
      `INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) ` +
      `VALUES ('${randomUUID()}', '${account.id}', '${type}', ${amount}, '${esc(merchant)}', ` +
      `'${category}', '${status}', '${esc(description)}', '${createdAt}');`;
    lines.push(wranglerCmd(sql));
  }
}

console.log(lines.join('\n'));
