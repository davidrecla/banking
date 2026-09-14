import { jsonResponse, errorResponse } from '../lib/auth.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

// Whitelisted so the `sort` query param can never be interpolated into SQL
// directly. Values are column names on `transactions` (t) or `accounts` (a).
const SORTABLE = {
  created_at: 't.created_at',
  amount: 't.amount',
  type: 't.type',
  merchant: 't.merchant',
  category: 't.category'
};

const TXN_TYPES = [
  'deposit',
  'withdrawal',
  'transfer_in',
  'transfer_out',
  'bill_payment',
  'loan_payment',
  'investment_purchase'
];

/**
 * GET /api/transactions
 *
 * Query params (all optional):
 *   accountId   — restrict to one of the caller's accounts
 *   type        — one of TXN_TYPES
 *   category    — exact category match
 *   search      — substring match on merchant or description
 *   minAmount   — inclusive lower bound
 *   maxAmount   — inclusive upper bound
 *   from / to   — ISO date (YYYY-MM-DD) bounds on created_at
 *   sort        — created_at | amount | type | merchant | category (default created_at)
 *   order       — asc | desc (default desc)
 *   limit       — 1..100 (default 25)
 *   offset      — >= 0 (default 0)
 *
 * Always scoped to the authenticated user by joining through `accounts`, so a
 * caller cannot read another user's transactions by guessing an accountId.
 */
export async function handleGetTransactions(request, env, auth) {
  const params = new URL(request.url).searchParams;

  const conditions = ['a.user_id = ?'];
  const binds = [auth.sub];

  const accountId = params.get('accountId');
  if (accountId) {
    conditions.push('t.account_id = ?');
    binds.push(accountId);
  }

  const type = params.get('type');
  if (type) {
    if (!TXN_TYPES.includes(type)) {
      return errorResponse(`type must be one of: ${TXN_TYPES.join(', ')}`, 400);
    }
    conditions.push('t.type = ?');
    binds.push(type);
  }

  const category = params.get('category');
  if (category) {
    conditions.push('t.category = ?');
    binds.push(category);
  }

  const search = params.get('search');
  if (search) {
    conditions.push('(t.merchant LIKE ? OR t.description LIKE ?)');
    const like = `%${search}%`;
    binds.push(like, like);
  }

  const minAmount = params.get('minAmount');
  if (minAmount !== null) {
    const parsed = parseFloat(minAmount);
    if (Number.isNaN(parsed)) return errorResponse('minAmount must be a number', 400);
    conditions.push('t.amount >= ?');
    binds.push(parsed);
  }

  const maxAmount = params.get('maxAmount');
  if (maxAmount !== null) {
    const parsed = parseFloat(maxAmount);
    if (Number.isNaN(parsed)) return errorResponse('maxAmount must be a number', 400);
    conditions.push('t.amount <= ?');
    binds.push(parsed);
  }

  const from = params.get('from');
  if (from) {
    conditions.push('t.created_at >= ?');
    binds.push(from);
  }

  const to = params.get('to');
  if (to) {
    // Inclusive of the whole `to` day when a bare date is given.
    conditions.push('t.created_at <= ?');
    binds.push(to.length === 10 ? `${to}T23:59:59.999Z` : to);
  }

  const sortKey = params.get('sort') || 'created_at';
  const sortColumn = SORTABLE[sortKey];
  if (!sortColumn) {
    return errorResponse(`sort must be one of: ${Object.keys(SORTABLE).join(', ')}`, 400);
  }
  const order = (params.get('order') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const limit = clampInt(params.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0);

  const where = conditions.join(' AND ');

  const countRow = await env.BANK_DB
    .prepare(`SELECT COUNT(*) AS total FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE ${where}`)
    .bind(...binds)
    .first();

  const { results } = await env.BANK_DB
    .prepare(
      `SELECT t.id, t.account_id, a.account_type, a.account_number, t.type, t.amount,
              t.merchant, t.category, t.status, t.description, t.created_at
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE ${where}
        ORDER BY ${sortColumn} ${order}
        LIMIT ? OFFSET ?`
    )
    .bind(...binds, limit, offset)
    .all();

  const total = countRow ? countRow.total : 0;

  return jsonResponse({
    transactions: results,
    pagination: { total, limit, offset, hasMore: offset + results.length < total }
  });
}

/** GET /api/transactions/:id — ownership-checked single transaction. */
export async function handleGetTransaction(request, env, auth, transactionId) {
  const transaction = await env.BANK_DB
    .prepare(
      `SELECT t.id, t.account_id, a.account_type, a.account_number, t.type, t.amount,
              t.merchant, t.category, t.status, t.description, t.created_at
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.id = ? AND a.user_id = ?`
    )
    .bind(transactionId, auth.sub)
    .first();

  if (!transaction) return errorResponse('Transaction not found', 404);
  return jsonResponse({ transaction });
}

function clampInt(raw, fallback, min, max) {
  const parsed = parseInt(raw || '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
