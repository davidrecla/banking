// Generates a PowerShell script of `wrangler d1 execute --command=...` calls
// that apply a schema file one statement at a time.
//
// Run: node scripts/generate-schema.mjs schema/003_phase3.sql > scripts/schema-003.ps1
// Then execute the generated .ps1 against the remote D1 database.
//
// Why not `wrangler d1 execute --file=...`? That path fails on this network
// with a generic `fetch failed` — see BUILD-PLAN.md "Local Environment Notes"
// note 1. Splitting into individual --command calls works.
//
// Supersedes the phase-specific generate-phase2-schema.mjs, which was the same
// code with a hardcoded path.

import { readFileSync } from 'node:fs';

const schemaFile = process.argv[2];
if (!schemaFile) {
  console.error('Usage: node scripts/generate-schema.mjs <path-to-schema.sql>');
  process.exit(1);
}

const sql = readFileSync(schemaFile, 'utf8');

// Strip comments before collapsing whitespace. Inline `--` comments MUST be
// removed per-line: once newlines collapse into spaces, an inline comment would
// swallow every column declared after it on the rest of the statement.
// Safe here because the schema files have no `--` or `;` inside string literals.
const statements = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .split(';')
  .map((s) => s.trim().replace(/\s+/g, ' '))
  .filter(Boolean);

function wranglerCmd(statement) {
  const psEscaped = statement.replace(/"/g, '`"');
  return `npx wrangler d1 execute bank-database --remote --command="${psEscaped};"`;
}

const lines = ['$env:CLOUDFLARE_ACCOUNT_ID="0feb844d7ff36330cdd00ed24797fe85"'];
for (const statement of statements) lines.push(wranglerCmd(statement));

console.log(lines.join('\n'));
console.error(`${statements.length} statements from ${schemaFile}`);
