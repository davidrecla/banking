import { jsonResponse, errorResponse } from '../lib/auth.js';

export async function handleGetAccounts(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare('SELECT id, account_type, account_number, balance, created_at FROM accounts WHERE user_id = ?')
    .bind(auth.sub)
    .all();

  return jsonResponse({ accounts: results });
}

export async function handleGetAccount(request, env, auth, accountId) {
  const account = await env.BANK_DB
    .prepare('SELECT id, account_type, account_number, balance, created_at FROM accounts WHERE id = ? AND user_id = ?')
    .bind(accountId, auth.sub)
    .first();

  if (!account) return errorResponse('Account not found', 404);
  return jsonResponse({ account });
}
