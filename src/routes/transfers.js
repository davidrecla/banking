import { jsonResponse, errorResponse } from '../lib/auth.js';
import { getDailyTransferTotal, addDailyTransferTotal } from '../lib/ratelimit.js';

const MAX_PER_TRANSACTION = 500;
const MAX_PER_DAY = 1000;

export async function handleInternalTransfer(request, env, auth) {
  const body = await request.json().catch(() => null);
  const { fromAccountId, toUsername, toAccountType, amount, note } = body || {};

  if (!fromAccountId || !toUsername || !toAccountType || !amount) {
    return errorResponse('fromAccountId, toUsername, toAccountType and amount are required', 400);
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return errorResponse('amount must be a positive number', 400);
  }
  if (amount > MAX_PER_TRANSACTION) {
    return errorResponse(`Internal transfers are limited to $${MAX_PER_TRANSACTION} per transaction`, 400);
  }

  const dailyTotal = await getDailyTransferTotal(env, auth.sub);
  if (dailyTotal + amount > MAX_PER_DAY) {
    return errorResponse(`Daily transfer limit of $${MAX_PER_DAY} would be exceeded`, 400);
  }

  const fromAccount = await env.BANK_DB
    .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
    .bind(fromAccountId, auth.sub)
    .first();
  if (!fromAccount) return errorResponse('Source account not found', 404);
  if (fromAccount.balance < amount) return errorResponse('Insufficient funds', 400);

  const toUser = await env.BANK_DB.prepare('SELECT * FROM users WHERE username = ?').bind(toUsername).first();
  if (!toUser) return errorResponse('Recipient not found', 404);

  const toAccount = await env.BANK_DB
    .prepare('SELECT * FROM accounts WHERE user_id = ? AND account_type = ?')
    .bind(toUser.id, toAccountType)
    .first();
  if (!toAccount) return errorResponse('Recipient account not found', 404);

  const now = new Date().toISOString();
  const outTxnId = crypto.randomUUID();
  const inTxnId = crypto.randomUUID();

  await env.BANK_DB.batch([
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').bind(amount, fromAccount.id),
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').bind(amount, toAccount.id),
    env.BANK_DB
      .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(outTxnId, fromAccount.id, 'transfer_out', amount, toUser.full_name, 'transfer', 'completed', note || null, now),
    env.BANK_DB
      .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(inTxnId, toAccount.id, 'transfer_in', amount, auth.username, 'transfer', 'completed', note || null, now)
  ]);

  await addDailyTransferTotal(env, auth.sub, amount);

  return jsonResponse({
    message: 'Transfer completed',
    from: { accountId: fromAccount.id, newBalance: fromAccount.balance - amount },
    to: { username: toUser.username, accountType: toAccount.account_type }
  });
}
