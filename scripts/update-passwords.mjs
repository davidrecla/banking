// Generates a PowerShell script of `wrangler d1 execute --command=...` calls
// to UPDATE existing users' password hashes (used when the password scheme
// changes after initial seeding, so existing accounts/transactions are kept).
//
// Run: node scripts/update-passwords.mjs > scripts/update-passwords-commands.ps1

import { hashPassword } from '../src/lib/crypto.js';

const users = [
  { username: 'chris.brown', password: 'cbrown123' },
  { username: 'sarah.johnson', password: 'sjohnson123' },
  { username: 'mike.davis', password: 'mdavis123' },
  { username: 'emma.wilson', password: 'ewilson123' },
  { username: 'admin', password: 'admin123' }
];

function esc(str) {
  return String(str).replace(/'/g, "''");
}

function wranglerCmd(sql) {
  const psEscaped = sql.replace(/"/g, '`"');
  return `npx wrangler d1 execute bank-database --remote --command="${psEscaped}"`;
}

const lines = ['$env:CLOUDFLARE_ACCOUNT_ID="0feb844d7ff36330cdd00ed24797fe85"'];

for (const u of users) {
  const { hash, salt } = await hashPassword(u.password);
  const sql = `UPDATE users SET password_hash = '${hash}', salt = '${salt}' WHERE username = '${esc(u.username)}';`;
  lines.push(wranglerCmd(sql));
}

console.log(lines.join('\n'));
