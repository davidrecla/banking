// Generates a PowerShell script of `wrangler d1 execute --command=...` calls
// to seed the 5 demo users + their 3 accounts each ($3000/account).
//
// Run: node scripts/generate-seed.mjs > scripts/seed-commands.ps1
// Then execute the generated .ps1 against the remote D1 database.
//
// Uses the same hashPassword() implementation as the running Worker
// (src/lib/crypto.js), so hashes generated here verify correctly at login.

import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/lib/crypto.js';

const users = [
  { username: 'chris.brown', fullName: 'Chris Brown', password: 'cbrown123', role: 'Regular' },
  { username: 'sarah.johnson', fullName: 'Sarah Johnson', password: 'sjohnson123', role: 'Premium' },
  { username: 'mike.davis', fullName: 'Mike Davis', password: 'mdavis123', role: 'Basic' },
  { username: 'emma.wilson', fullName: 'Emma Wilson', password: 'ewilson123', role: 'VIP' },
  { username: 'admin', fullName: 'Admin User', password: 'admin123', role: 'Admin' }
];

const ACCOUNT_TYPES = ['savings', 'checking', 'investment'];
const STARTING_BALANCE = 3000;

function esc(str) {
  return String(str).replace(/'/g, "''");
}

function wranglerCmd(sql) {
  // Escape for PowerShell double-quoted string: backtick-escape internal double quotes.
  const psEscaped = sql.replace(/"/g, '`"');
  return `npx wrangler d1 execute bank-database --remote --command="${psEscaped}"`;
}

const lines = [];
lines.push('$env:CLOUDFLARE_ACCOUNT_ID="0feb844d7ff36330cdd00ed24797fe85"');

let accountNumberCounter = 1000000001;

for (const u of users) {
  const userId = randomUUID();
  const { hash, salt } = await hashPassword(u.password);
  const memberSince = new Date().toISOString().slice(0, 10);

  const insertUser = `INSERT INTO users (id, username, full_name, password_hash, salt, role, member_since, account_frozen) VALUES ('${userId}', '${esc(u.username)}', '${esc(u.fullName)}', '${hash}', '${salt}', '${esc(u.role)}', '${memberSince}', 0);`;
  lines.push(wranglerCmd(insertUser));

  for (const accountType of ACCOUNT_TYPES) {
    const accountId = randomUUID();
    const accountNumber = String(accountNumberCounter++);
    const insertAccount = `INSERT INTO accounts (id, user_id, account_type, account_number, balance) VALUES ('${accountId}', '${userId}', '${accountType}', '${accountNumber}', ${STARTING_BALANCE});`;
    lines.push(wranglerCmd(insertAccount));
  }
}

console.log(lines.join('\n'));
