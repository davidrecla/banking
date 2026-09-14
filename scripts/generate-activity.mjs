// Generates a PowerShell script seeding audit-log entries and notifications
// for the demo users, so the Profile page has history to show before anyone
// has clicked anything.
//
// Run: node scripts/generate-activity.mjs <users.json> > scripts/activity-seed.ps1
// Then execute the generated .ps1 against the remote D1 database.
//
// Produce users.json first:
//   npx wrangler d1 execute bank-database --remote --json \
//     --command="SELECT id, username, full_name FROM users;" > scripts/users.json
//
// IMPORTANT CONSTRAINT: seeded audit entries must never claim that money moved.
// The ledger reconciles (see BUILD-PLAN.md "The ledger reconciles"), so an
// entry like "Paid $42.50 to FiberNet" with no matching transaction row would
// contradict the account history and undermine exactly the credibility the
// reconciliation work bought. Only session, security and document events are
// seeded here; money-movement entries are written by the real endpoints when
// someone actually performs the action.
//
// Individual --command calls rather than a single --file, per BUILD-PLAN.md
// "Local Environment Notes" note 1. Seeded RNG so reruns are reproducible.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const usersFile = process.argv[2];
if (!usersFile) {
  console.error('Usage: node scripts/generate-activity.mjs <users.json>');
  console.error('See the header comment for the query to produce it.');
  process.exit(1);
}

let rngState = 31415926;
function rnd() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

const raw = JSON.parse(readFileSync(usersFile, 'utf8'));
const users = (Array.isArray(raw) ? raw[0].results : raw.results) || [];
if (users.length === 0) {
  console.error('No users found in the provided file.');
  process.exit(1);
}

// Plausible residential-looking addresses; none are real customer data.
const IPS = ['203.0.113.24', '198.51.100.87', '203.0.113.142', '198.51.100.19', '192.0.2.203'];
const AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/17.6',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari'
];

// Session/security/document events only — deliberately nothing that implies a
// balance change. See the constraint note at the top of this file.
const EVENTS = [
  ['login', (u) => `Signed in as ${u.username}`],
  ['login', (u) => `Signed in as ${u.username}`],
  ['logout', () => 'Signed out'],
  ['login_failed', (u) => `Failed login for ${u.username}`],
  ['statement_generate', () => 'Generated a PDF statement for checking covering the last 3 months'],
  ['card_block', () => 'Blocked debit card **** **** **** 4417'],
  ['card_unblock', () => 'Unblocked debit card **** **** **** 4417'],
  ['login', (u) => `Signed in as ${u.username}`]
];

const NOTIFICATIONS = [
  ['security', 'New sign-in detected', 'A new sign-in to your account was detected. If this was not you, contact us immediately.'],
  ['account', 'Statement ready', 'Your latest account statement is available to download.'],
  ['promotion', 'Fixed Deposit at 4.5%', 'Lock in 4.5% p.a. on a Fixed Deposit for terms from 6 months.']
];

function esc(str) {
  return String(str).replace(/'/g, "''");
}

function wranglerCmd(sql) {
  return `npx wrangler d1 execute bank-database --remote --command="${sql.replace(/"/g, '`"')}"`;
}

const DAYS_BACK = 21;
const now = Date.now();

function timestampWithinDays(days) {
  return new Date(now - rnd() * days * 24 * 60 * 60 * 1000).toISOString();
}

const lines = ['$env:CLOUDFLARE_ACCOUNT_ID="0feb844d7ff36330cdd00ed24797fe85"'];
let auditCount = 0;
let notifCount = 0;

for (const user of users) {
  for (const [eventType, detailFor] of EVENTS) {
    const sql =
      `INSERT INTO audit_logs (id, user_id, event_type, detail, ip_address, user_agent, created_at) ` +
      `VALUES ('${randomUUID()}', '${user.id}', '${eventType}', '${esc(detailFor(user))}', ` +
      `'${pick(IPS)}', '${esc(pick(AGENTS))}', '${timestampWithinDays(DAYS_BACK)}');`;
    lines.push(wranglerCmd(sql));
    auditCount++;
  }

  for (const [type, title, message] of NOTIFICATIONS) {
    // Leave most unread so the badge is visible during a demo.
    const read = rnd() < 0.3 ? 1 : 0;
    const sql =
      `INSERT INTO notifications (id, user_id, type, title, message, read, created_at) ` +
      `VALUES ('${randomUUID()}', '${user.id}', '${type}', '${esc(title)}', '${esc(message)}', ${read}, '${timestampWithinDays(DAYS_BACK)}');`;
    lines.push(wranglerCmd(sql));
    notifCount++;
  }
}

console.log(lines.join('\n'));
console.error(`${auditCount} audit entries and ${notifCount} notifications for ${users.length} users`);
console.error('no seeded entry implies money movement — see the constraint note in this file');
