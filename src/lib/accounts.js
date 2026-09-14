import { errorResponse } from './auth.js';

/**
 * Loads an account and confirms it belongs to the caller.
 * Returns { account } or { response } — the caller returns `response` as-is.
 */
export async function loadOwnedAccount(env, auth, accountId, notFoundMessage = 'Account not found') {
  const account = await env.BANK_DB
    .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
    .bind(accountId, auth.sub)
    .first();

  if (!account) return { response: errorResponse(notFoundMessage, 404) };
  return { account };
}

/**
 * Same as loadOwnedAccount, but also refuses frozen accounts.
 *
 * Every path that takes money OUT of an account must use this, otherwise a
 * freeze is decorative: the flag would be set while transfers, bill payments,
 * investments and external transfers all still drained the account. Credits
 * (loan disbursement, investment withdrawal, incoming transfers) deliberately
 * remain allowed on a frozen account, which is how real banks treat a freeze —
 * money can arrive, it just cannot leave.
 */
export async function loadDebitableAccount(env, auth, accountId, notFoundMessage = 'Account not found') {
  const result = await loadOwnedAccount(env, auth, accountId, notFoundMessage);
  if (result.response) return result;

  if (result.account.frozen) {
    return {
      response: errorResponse(
        'This account is frozen. Unfreeze it before making payments or transfers.',
        403
      )
    };
  }
  return result;
}
