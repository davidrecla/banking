/**
 * INTENTIONALLY VULNERABLE endpoints for the Phase 4 security showcase.
 *
 * Every handler here maps to an OWASP API Security Top 10 entry (see the
 * vulnerability matrix in BUILD-PLAN.md) and deliberately omits the check that
 * a real endpoint would enforce. They exist so a demo can show them being
 * exploited, then show Cloudflare (API Shield schema validation, JWT
 * validation, rate limiting rules, API Discovery) blocking the same requests
 * at the edge without origin changes.
 *
 * DO NOT copy any of these patterns into the legitimate API surface, and do
 * not mitigate them in code — the whole point is that the edge, not the app,
 * is what stops the attacks. Each handler's comment states exactly which
 * control is missing and which Cloudflare feature is expected to block it.
 *
 * API6 (Unrestricted Access to Sensitive Business Flows) needs no code: the
 * existing loan/investment endpoints already lack per-day caps and serve as
 * the attack surface.
 */
import { jsonResponse, errorResponse } from '../lib/auth.js';
import { loadDebitableAccount } from '../lib/accounts.js';
import { recordAudit, notify } from '../lib/activity.js';

/**
 * API1 — BOLA. GET /api/users/:userId/balance
 * Missing: object-level authorization — no comparison of :userId against
 * auth.sub, so any authenticated user reads any user's balances.
 * Expected edge block: WAF rate limiting rule on the enumeration pattern.
 */
export async function handleGetUserBalance(request, env, auth, userId) {
  const user = await env.BANK_DB
    .prepare('SELECT id, username, full_name, role FROM users WHERE id = ?')
    .bind(userId)
    .first();
  if (!user) return errorResponse('User not found', 404);

  const { results: accounts } = await env.BANK_DB
    .prepare('SELECT id, account_type, account_number, balance FROM accounts WHERE user_id = ?')
    .bind(userId)
    .all();

  return jsonResponse({ user, accounts });
}

/**
 * API2 — Broken authentication. GET /api/internal/debug
 * Missing: authentication entirely (registered as a public route in the
 * router). Exposes the full user table including password hashes and salts.
 * Expected edge block: JWT validation rule requiring a valid token.
 */
export async function handleInternalDebug(env) {
  const { results: users } = await env.BANK_DB
    .prepare('SELECT id, username, full_name, role, member_since, account_frozen, password_hash, salt FROM users')
    .all();

  // Obviously-fake, publicly-documented SSNs (e.g. 078-05-1120 is the famous
  // 1938 Woolworth-specimen number used to advertise lock wallets) so the dump
  // reads plausibly sensitive AND reliably trips sensitive-data detection. They
  // are deterministic per user so repeat demos look identical, and there are no
  // real identifiers behind them — see BUILD-PLAN parity note for PANs.
  const FAKE_SSNS = ['078-05-1120', '219-09-9999', '457-55-5462', '234-56-7890', '111-22-3333'];
  const enriched = users.map((u, i) => ({ ...u, ssn: FAKE_SSNS[i % FAKE_SSNS.length] }));

  return jsonResponse({
    environment: 'production',
    worker: 'banking',
    auth: { algorithm: 'HS256', secretSource: 'env.JWT_SECRET', tokenTtlSeconds: 86400 },
    rateLimits: { loginAttemptsPerMinute: 5, internalTransferDailyMaxUsd: 1000 },
    bindings: ['BANK_DB', 'BANK_KV', 'BANK_BUCKET'],
    users: enriched
  });
}

/**
 * API3 — Excessive data exposure. GET /api/profile (?internal=1 for full mode)
 * Missing: response minimisation — the base response already leaks password
 * hash, salt and internal flags instead of just the fields the UI needs.
 * The undocumented `?internal=1` param additionally dumps the caller's raw
 * account rows and the whole session payload.
 * Expected edge block: schema validation rejects the undeclared query param.
 */
export async function handleGetProfile(request, env, auth) {
  const user = await env.BANK_DB
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(auth.sub)
    .first();
  if (!user) return errorResponse('User not found', 404);

  const profile = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    memberSince: user.member_since,
    accountFrozen: user.account_frozen === 1,
    passwordHash: user.password_hash,
    salt: user.salt
  };

  if (new URL(request.url).searchParams.get('internal') === '1') {
    const { results: accounts } = await env.BANK_DB
      .prepare('SELECT * FROM accounts WHERE user_id = ?')
      .bind(user.id)
      .all();
    profile.internal = {
      session: auth,
      databaseFlags: { account_frozen: user.account_frozen },
      // Fake, publicly-documented SSN format for the sensitive-data detection leg.
      ssn: '078-05-1120',
      accounts
    };
  }

  return jsonResponse({ profile });
}

/**
 * API4 — Unrestricted resource consumption. POST /api/transfers/express
 * body { fromAccountId, toUsername, toAccountType, amount, note? }
 * Missing: every rate limit — no login-style attempt counter and no KV-backed
 * daily total (unlike /api/transfers/internal). Per-transaction cap stays only
 * so a broken amount can't silently violate the ledger invariant.
 * Expected edge block: WAF rate limiting rule on the path.
 */
export async function handleExpressTransfer(request, env, auth) {
  const body = await request.json().catch(() => null);
  const { fromAccountId, toUsername, toAccountType, amount, note } = body || {};

  if (!fromAccountId || !toUsername || !toAccountType || !amount) {
    return errorResponse('fromAccountId, toUsername, toAccountType and amount are required', 400);
  }
  if (typeof amount !== 'number' || amount <= 0 || amount > 500) {
    return errorResponse('amount must be a positive number up to $500', 400);
  }

  const source = await loadDebitableAccount(env, auth, fromAccountId, 'Source account not found');
  if (source.response) return source.response;
  const fromAccount = source.account;
  if (fromAccount.balance < amount) return errorResponse('Insufficient funds', 400);

  const toUser = await env.BANK_DB.prepare('SELECT * FROM users WHERE username = ?').bind(toUsername).first();
  if (!toUser) return errorResponse('Recipient not found', 404);

  const toAccount = await env.BANK_DB
    .prepare('SELECT * FROM accounts WHERE user_id = ? AND account_type = ?')
    .bind(toUser.id, toAccountType)
    .first();
  if (!toAccount) return errorResponse('Recipient account not found', 404);

  const now = new Date().toISOString();

  await env.BANK_DB.batch([
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').bind(amount, fromAccount.id),
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').bind(amount, toAccount.id),
    env.BANK_DB
      .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), fromAccount.id, 'transfer_out', amount, toUser.full_name, 'transfer', 'completed', note || null, now),
    env.BANK_DB
      .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), toAccount.id, 'transfer_in', amount, auth.username, 'transfer', 'completed', note || null, now)
  ]);

  await recordAudit(
    env,
    request,
    auth.sub,
    'transfer_express',
    `Sent $${amount.toFixed(2)} to ${toUser.username} (${toAccount.account_type}) via express transfer (no rate limit)`
  );
  await notify(
    env,
    toUser.id,
    'transaction',
    'Money received',
    `${auth.username} sent you $${amount.toFixed(2)} to your ${toAccount.account_type} account.`
  );

  return jsonResponse({
    message: 'Express transfer completed',
    from: { accountId: fromAccount.id, newBalance: fromAccount.balance - amount },
    to: { username: toUser.username, accountType: toAccount.account_type }
  }, 201);
}

/**
 * API5 — BFLA (list). GET /api/admin/users
 * Missing: function-level authorization — no role check, so any authenticated
 * user (not just admins) lists every user with roles, balances and status.
 * Expected edge blocks: schema fallthrough rule (endpoint not in the uploaded
 * OpenAPI schema) and a JWT-claims rule on role != "admin".
 */
export async function handleAdminListUsers(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.member_since, u.account_frozen,
              a.id AS account_id, a.account_type, a.balance
         FROM users u
         LEFT JOIN accounts a ON a.user_id = u.id
        ORDER BY u.username`
    )
    .all();

  const users = [];
  for (const row of results) {
    let user = users.find((u) => u.id === row.id);
    if (!user) {
      user = { id: row.id, username: row.username, fullName: row.full_name, role: row.role, memberSince: row.member_since, accountFrozen: row.account_frozen === 1, accounts: [] };
      users.push(user);
    }
    if (row.account_id) user.accounts.push({ id: row.account_id, type: row.account_type, balance: row.balance });
  }

  return jsonResponse({ users });
}

/**
 * API5 — BFLA (action). POST /api/admin/loans/:id/force-approve
 * Missing: function-level authorization — no role check before performing a
 * privileged admin action: approving a pending_review loan and disbursing it.
 * Expected edge blocks: same fallthrough + role-claim rules as above.
 */
export async function handleAdminForceApproveLoan(request, env, auth, loanId) {
  const loan = await env.BANK_DB
    .prepare('SELECT * FROM loans WHERE id = ?')
    .bind(loanId)
    .first();
  if (!loan) return errorResponse('Loan not found', 404);
  if (loan.status !== 'pending_review') {
    return errorResponse(`Loan is ${loan.status}; only pending_review loans can be approved`, 400);
  }
  if (!loan.disburse_account_id) {
    return errorResponse('Loan has no disbursement account attached', 400);
  }

  const now = new Date().toISOString();
  await env.BANK_DB.batch([
    env.BANK_DB.prepare("UPDATE loans SET status = 'approved' WHERE id = ?").bind(loanId),
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').bind(loan.amount, loan.disburse_account_id),
    env.BANK_DB
      .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), loan.disburse_account_id, 'deposit', loan.amount, 'PGC Bank Loan Disbursement', 'loan', 'completed', `Loan disbursement (${loan.term_months} months @ ${loan.interest_rate}%)`, now)
  ]);

  await recordAudit(
    env,
    request,
    loan.user_id,
    'loan_force_approve',
    `Loan ${loanId} ($${loan.amount.toFixed(2)}) force-approved from pending_review by ${auth.username}`
  );
  await notify(
    env,
    loan.user_id,
    'account',
    'Loan approved',
    `Your $${loan.amount.toFixed(2)} loan was approved and disbursed. Monthly payment $${loan.monthly_payment.toFixed(2)}.`
  );

  return jsonResponse({ message: 'Loan approved and disbursed', loan: { id: loan.id, amount: loan.amount, status: 'approved' } });
}

/**
 * API7 — SSRF. POST /api/profile/avatar-from-url
 * body { url }
 * Missing: URL validation — the Worker fetches any scheme/host the caller
 * supplies (link-local metadata IPs included) and returns what it got.
 * Expected edge block: schema validation pins `url` to an allowlisted CDN
 * pattern; otherwise a custom rule matches private-IP strings in the body.
 */
export async function handleAvatarFromUrl(request, env, auth) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.url !== 'string' || body.url.length === 0) {
    return errorResponse('url is required', 400);
  }

  try {
    const upstream = await fetch(body.url);
    const text = await upstream.text();
    return jsonResponse({
      fetchedUrl: body.url,
      status: upstream.status,
      contentType: upstream.headers.get('content-type'),
      bodyPreview: text.slice(0, 500)
    });
  } catch (err) {
    // Deliberately verbose: surfaces the Worker's fetch error to the caller.
    return errorResponse(`Could not fetch avatar URL: ${err.message}`, 502);
  }
}

/**
 * API8 — Security misconfiguration. POST /api/debug/parse
 * Missing: handled errors — malformed JSON produces a 500 containing the raw
 * parser error, the JS stack trace and internal hints, instead of a clean 400.
 * Expected edge block: schema validation 400s type-invalid bodies before the
 * Worker can produce an error surface at all.
 */
export async function handleDebugParse(request, env, auth) {
  const raw = await request.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return jsonResponse(
      {
        error: `JSON.parse failed at ${err.message}`,
        stack: err.stack,
        receivedBody: raw.slice(0, 200),
        hint: 'internal parser: src/routes/vulnerable.js:handleDebugParse'
      },
      500
    );
  }
  return jsonResponse({ parsed });
}

/**
 * API9 — Improper inventory management. GET /api/v1/accounts (?userId=)
 * A deprecated v1-era endpoint that was never retired: undocumented, absent
 * from the OpenAPI schema we will upload, and still serving verbose rows
 * (full account numbers, freeze flags). Accepts a userId override that was
 * never removed either.
 * Expected edge behavior: surfaces in API Discovery as a shadow operation,
 * then blocked by the fallthrough rule once only-schema traffic is enforced.
 */
export async function handleV1Accounts(request, env, auth) {
  const userId = new URL(request.url).searchParams.get('userId') || auth.sub;

  const { results } = await env.BANK_DB
    .prepare(
      `SELECT a.*, u.username, u.full_name
         FROM accounts a
         JOIN users u ON u.id = a.user_id
        WHERE a.user_id = ?`
    )
    .bind(userId)
    .all();

  return jsonResponse({ apiVersion: 'v1 (deprecated)', accounts: results });
}
