import { jsonResponse, errorResponse } from '../lib/auth.js';
import { recordAndNotify } from '../lib/activity.js';

export async function handleGetAccounts(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare('SELECT id, account_type, account_number, balance, frozen, created_at FROM accounts WHERE user_id = ?')
    .bind(auth.sub)
    .all();

  return jsonResponse({ accounts: results });
}

export async function handleGetAccount(request, env, auth, accountId) {
  const account = await env.BANK_DB
    .prepare('SELECT id, account_type, account_number, balance, frozen, created_at FROM accounts WHERE id = ? AND user_id = ?')
    .bind(accountId, auth.sub)
    .first();

  if (!account) return errorResponse('Account not found', 404);
  return jsonResponse({ account });
}

/** POST /api/accounts/:id/freeze */
export async function handleFreezeAccount(request, env, auth, accountId) {
  return setFrozen(request, env, auth, accountId, 1);
}

/** POST /api/accounts/:id/unfreeze */
export async function handleUnfreezeAccount(request, env, auth, accountId) {
  return setFrozen(request, env, auth, accountId, 0);
}

/**
 * A freeze is enforced, not cosmetic: every debit path loads its source account
 * through loadDebitableAccount() in src/lib/accounts.js, which refuses frozen
 * accounts with a 403. Credits are still allowed, so money can arrive but not
 * leave — the same way a real bank treats a frozen account.
 */
async function setFrozen(request, env, auth, accountId, frozen) {
  const account = await env.BANK_DB
    .prepare('SELECT id, account_type, account_number, frozen FROM accounts WHERE id = ? AND user_id = ?')
    .bind(accountId, auth.sub)
    .first();
  if (!account) return errorResponse('Account not found', 404);

  if (account.frozen === frozen) {
    return errorResponse(frozen ? 'Account is already frozen' : 'Account is not frozen', 400);
  }

  await env.BANK_DB.prepare('UPDATE accounts SET frozen = ? WHERE id = ?').bind(frozen, accountId).run();

  await recordAndNotify(
    env,
    request,
    auth.sub,
    frozen ? 'account_freeze' : 'account_unfreeze',
    `${frozen ? 'Froze' : 'Unfroze'} ${account.account_type} account ${account.account_number}`,
    {
      type: 'security',
      title: frozen ? 'Account frozen' : 'Account unfrozen',
      message: frozen
        ? `Your ${account.account_type} account is frozen. Outgoing payments and transfers are blocked.`
        : `Your ${account.account_type} account is active again. Payments and transfers are allowed.`
    }
  );

  return jsonResponse({
    message: frozen ? 'Account frozen' : 'Account unfrozen',
    account: { id: accountId, frozen: Boolean(frozen) }
  });
}
