// Generates a PowerShell script of `wrangler d1 execute --command=...` calls
// that seed ~95 mock transactions across the last 6 months AND set each
// account's balance to the value that history implies.
//
// Run: node scripts/generate-transactions.mjs <accounts.json> > scripts/transactions-seed.ps1
// Then execute the generated .ps1 against the remote D1 database.
//
// Produce accounts.json first:
//   npx wrangler d1 execute bank-database --remote --json \
//     --command="SELECT a.id, a.account_type, u.username FROM accounts a JOIN users u ON u.id = a.user_id;" \
//     > scripts/accounts.json
//
// Individual --command calls rather than a single --file, per BUILD-PLAN.md
// "Local Environment Notes" note 1.
//
// THE LEDGER RECONCILES. This is the point of the script, and the earlier
// version got it wrong: it wrote random rows and left balances untouched, so
// sum(credits) - sum(debits) bore no relation to the displayed balance. Here
// the run is simulated chronologically against a running balance per account:
//
//   - Every account opens with a visible $3000 "Opening balance" deposit, so
//     the history fully explains where the money came from.
//   - Debits that would overdraw an account are skipped rather than applied,
//     so no balance ever goes negative.
//   - Transfers between demo users are written as real double-entry PAIRS:
//     a transfer_out on the source and a matching transfer_in on the
//     destination, same amount and timestamp. Cross-checking two demo accounts
//     therefore shows both halves.
//   - Rows with status 'pending' or 'failed' deliberately do NOT move the
//     balance, mirroring how a real ledger treats unsettled entries.
//
// The invariant a future session should re-check after any change:
//   balance == sum(completed credits) - sum(completed debits)   [per account]
// where credits are deposit|transfer_in and debits are everything else.
//
// The RNG is seeded from a constant so re-running produces identical data,
// which keeps demos reproducible. Change SEED to get a different dataset.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const accountsFile = process.argv[2];
if (!accountsFile) {
  console.error('Usage: node scripts/generate-transactions.mjs <accounts.json>');
  console.error('See the header comment for how to produce accounts.json.');
  process.exit(1);
}

const SEED = 20260914;
const OPENING_BALANCE = 3000;
const MONTHS_BACK = 6;
const SINGLE_EVENTS = 60;
const TRANSFER_EVENTS = 10;
const CREDIT_TYPES = ['deposit', 'transfer_in'];

// Deterministic LCG — Math.random() would make every run produce a different
// dataset, which is unhelpful when a demo needs to look the same twice.
let rngState = SEED;
function rnd() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}
function amountIn([min, max]) {
  return Math.round((min + rnd() * (max - min)) * 100) / 100;
}

const raw = JSON.parse(readFileSync(accountsFile, 'utf8'));
const accounts = (Array.isArray(raw) ? raw[0].results : raw.results) || [];
if (accounts.length === 0) {
  console.error('No accounts found in the provided file.');
  process.exit(1);
}

// [type, category, merchants[], amountRange]
const SINGLE_PATTERNS = [
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
  ['investment_purchase', 'investment', ['PGC Money Market Fund', 'PGC Balanced Fund'], [200, 1500]]
];

const TRANSFER_NOTES = ['Rent share', 'Dinner split', 'Gift', 'Shared bill', 'Loan repayment', null];

function esc(str) {
  return String(str).replace(/'/g, "''");
}

function wranglerCmd(sql) {
  const psEscaped = sql.replace(/"/g, '`"');
  return `npx wrangler d1 execute bank-database --remote --command="${psEscaped}"`;
}

function insertSql(row) {
  // ASCII only: non-ASCII gets mangled when PowerShell reads the generated
  // .ps1 (BUILD-PLAN.md note 7).
  return (
    `INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) ` +
    `VALUES ('${randomUUID()}', '${row.accountId}', '${row.type}', ${row.amount}, '${esc(row.merchant)}', ` +
    `'${row.category}', '${row.status}', '${esc(row.description)}', '${row.createdAt}');`
  );
}

const now = Date.now();
const earliest = now - MONTHS_BACK * 30 * 24 * 60 * 60 * 1000;
// Opening deposits sit just before the earliest activity so they always sort first.
const openingIso = new Date(earliest - 24 * 60 * 60 * 1000).toISOString();

const balances = new Map();
const rows = [];

for (const account of accounts) {
  balances.set(account.id, OPENING_BALANCE);
  rows.push({
    accountId: account.id,
    type: 'deposit',
    amount: OPENING_BALANCE,
    merchant: 'PGC Bank',
    category: 'opening',
    status: 'completed',
    description: 'Opening balance',
    createdAt: openingIso
  });
}

// Build the event list first, then apply it in timestamp order so that a
// transfer can never spend money the source account has not yet received.
const events = [];

for (let i = 0; i < SINGLE_EVENTS; i++) {
  events.push({ kind: 'single', at: earliest + rnd() * (now - earliest) });
}
for (let i = 0; i < TRANSFER_EVENTS; i++) {
  events.push({ kind: 'transfer', at: earliest + rnd() * (now - earliest) });
}
events.sort((a, b) => a.at - b.at);

let skipped = 0;
let singleIndex = 0;

// Statuses are assigned on a fixed cadence rather than by random draw. Leaving
// it to chance produced a dataset with four 'failed' rows and zero 'pending'
// ones, so the pending status pill could not be demonstrated in the UI at all.
// Unsettled rows never move the balance, so this does not affect reconciliation.
function statusFor(index) {
  if (index % 13 === 4) return 'pending';
  if (index % 17 === 7) return 'failed';
  return 'completed';
}

for (const event of events) {
  const createdAt = new Date(event.at).toISOString();

  if (event.kind === 'single') {
    const account = pick(accounts);
    const [type, category, merchants, range] = pick(SINGLE_PATTERNS);
    const merchant = pick(merchants);
    const amount = amountIn(range);
    const isCredit = CREDIT_TYPES.includes(type);
    const status = statusFor(singleIndex++);

    if (!isCredit && status === 'completed' && balances.get(account.id) < amount) {
      skipped++;
      continue;
    }

    if (status === 'completed') {
      balances.set(account.id, balances.get(account.id) + (isCredit ? amount : -amount));
    }

    rows.push({
      accountId: account.id,
      type,
      amount,
      merchant,
      category,
      status,
      description: `${category} - ${merchant}`,
      createdAt
    });
    continue;
  }

  // Transfer: pick two accounts belonging to different users so the pair looks
  // like a real person-to-person transfer.
  const from = pick(accounts);
  const candidates = accounts.filter((a) => a.username !== from.username);
  const to = pick(candidates);
  const amount = amountIn([20, 480]);

  if (balances.get(from.id) < amount) {
    skipped++;
    continue;
  }

  const note = pick(TRANSFER_NOTES);
  const fromName = titleCase(from.username);
  const toName = titleCase(to.username);

  balances.set(from.id, balances.get(from.id) - amount);
  balances.set(to.id, balances.get(to.id) + amount);

  rows.push({
    accountId: from.id,
    type: 'transfer_out',
    amount,
    merchant: toName,
    category: 'transfer',
    status: 'completed',
    description: note || `Transfer to ${toName}`,
    createdAt
  });
  rows.push({
    accountId: to.id,
    type: 'transfer_in',
    amount,
    merchant: fromName,
    category: 'transfer',
    status: 'completed',
    description: note || `Transfer from ${fromName}`,
    createdAt
  });
}

function titleCase(username) {
  return username
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const lines = ['$env:CLOUDFLARE_ACCOUNT_ID="0feb844d7ff36330cdd00ed24797fe85"'];
for (const row of rows) lines.push(wranglerCmd(insertSql(row)));

// Balances are written last so the accounts table matches the ledger exactly.
for (const account of accounts) {
  const balance = Math.round(balances.get(account.id) * 100) / 100;
  lines.push(wranglerCmd(`UPDATE accounts SET balance = ${balance} WHERE id = '${account.id}';`));
}

console.log(lines.join('\n'));

console.error(`rows: ${rows.length} (${accounts.length} opening + ${rows.length - accounts.length} activity)`);
console.error(`skipped (would have overdrawn): ${skipped}`);
console.error('balances written:');
for (const account of accounts) {
  console.error(
    `  ${account.username.padEnd(15)} ${account.account_type.padEnd(11)} ` +
      `${(Math.round(balances.get(account.id) * 100) / 100).toFixed(2)}`
  );
}
