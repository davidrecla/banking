import { jsonResponse, errorResponse } from '../lib/auth.js';
import { loadDebitableAccount } from '../lib/accounts.js';
import { recordAndNotify } from '../lib/activity.js';

const MAX_PER_TRANSACTION = 2000;

export const BILL_TYPES = [
  'electricity',
  'water',
  'internet',
  'mobile',
  'credit_card',
  'insurance'
];

/** GET /api/bills/payees — the caller's saved payees. */
export async function handleGetPayees(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare('SELECT id, name, bill_type, account_number, created_at FROM payees WHERE user_id = ? ORDER BY name')
    .bind(auth.sub)
    .all();

  return jsonResponse({ payees: results });
}

/** POST /api/bills/payees — body { name, billType, accountNumber } */
export async function handleCreatePayee(request, env, auth) {
  const body = await request.json().catch(() => null);
  const { name, billType, accountNumber } = body || {};

  if (!name || !billType || !accountNumber) {
    return errorResponse('name, billType and accountNumber are required', 400);
  }
  if (!BILL_TYPES.includes(billType)) {
    return errorResponse(`billType must be one of: ${BILL_TYPES.join(', ')}`, 400);
  }

  const id = crypto.randomUUID();
  await env.BANK_DB
    .prepare('INSERT INTO payees (id, user_id, name, bill_type, account_number, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, auth.sub, name, billType, accountNumber, new Date().toISOString())
    .run();

  return jsonResponse({ payee: { id, name, billType, accountNumber } }, 201);
}

/** DELETE /api/bills/payees/:id — ownership-checked. */
export async function handleDeletePayee(request, env, auth, payeeId) {
  const payee = await env.BANK_DB
    .prepare('SELECT id FROM payees WHERE id = ? AND user_id = ?')
    .bind(payeeId, auth.sub)
    .first();
  if (!payee) return errorResponse('Payee not found', 404);

  // Paid bills keep their own payee_name/account_number copies, so removing a
  // payee does not rewrite payment history.
  await env.BANK_DB.prepare('DELETE FROM payees WHERE id = ?').bind(payeeId).run();

  return jsonResponse({ message: 'Payee deleted' });
}

/**
 * POST /api/bills/pay
 * body { fromAccountId, amount, payeeId? , payeeName?, billType?, accountNumber?, dueDate?, memo? }
 *
 * Either reference a saved payee via payeeId, or pass the payee details inline
 * for a one-off payment.
 */
export async function handlePayBill(request, env, auth) {
  const body = await request.json().catch(() => null);
  const { fromAccountId, amount, payeeId, dueDate, memo } = body || {};

  if (!fromAccountId || !amount) {
    return errorResponse('fromAccountId and amount are required', 400);
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return errorResponse('amount must be a positive number', 400);
  }
  if (amount > MAX_PER_TRANSACTION) {
    return errorResponse(`Bill payments are limited to $${MAX_PER_TRANSACTION} per transaction`, 400);
  }

  let payeeName = body.payeeName;
  let billType = body.billType;
  let accountNumber = body.accountNumber;

  if (payeeId) {
    const payee = await env.BANK_DB
      .prepare('SELECT * FROM payees WHERE id = ? AND user_id = ?')
      .bind(payeeId, auth.sub)
      .first();
    if (!payee) return errorResponse('Payee not found', 404);
    payeeName = payee.name;
    billType = payee.bill_type;
    accountNumber = payee.account_number;
  }

  if (!payeeName || !billType || !accountNumber) {
    return errorResponse('Either payeeId, or payeeName + billType + accountNumber, are required', 400);
  }
  if (!BILL_TYPES.includes(billType)) {
    return errorResponse(`billType must be one of: ${BILL_TYPES.join(', ')}`, 400);
  }

  const source = await loadDebitableAccount(env, auth, fromAccountId, 'Source account not found');
  if (source.response) return source.response;
  const account = source.account;
  if (account.balance < amount) return errorResponse('Insufficient funds', 400);

  const now = new Date().toISOString();
  const billId = crypto.randomUUID();
  const confirmationNumber = generateConfirmation();

  // Debit, ledger entry and bill record are written together so a bill can
  // never be recorded without the matching debit (or vice versa).
  await env.BANK_DB.batch([
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').bind(amount, account.id),
    env.BANK_DB
      .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), account.id, 'bill_payment', amount, payeeName, billType, 'completed', memo || `Bill payment to ${payeeName}`, now),
    env.BANK_DB
      .prepare('INSERT INTO bills (id, user_id, payee_id, from_account_id, bill_type, payee_name, account_number, amount, due_date, memo, confirmation_number, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(billId, auth.sub, payeeId || null, account.id, billType, payeeName, accountNumber, amount, dueDate || null, memo || null, confirmationNumber, 'completed', now)
  ]);

  await recordAndNotify(
    env,
    request,
    auth.sub,
    'bill_payment',
    `Paid $${amount.toFixed(2)} to ${payeeName} (${billType}), confirmation ${confirmationNumber}`,
    {
      type: 'transaction',
      title: 'Bill paid',
      message: `$${amount.toFixed(2)} paid to ${payeeName}. Confirmation ${confirmationNumber}.`
    }
  );

  return jsonResponse({
    message: 'Bill paid',
    bill: {
      id: billId,
      payeeName,
      billType,
      amount,
      confirmationNumber,
      status: 'completed',
      createdAt: now
    },
    newBalance: account.balance - amount
  }, 201);
}

/** GET /api/bills — the caller's payment history, newest first. */
export async function handleGetBills(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare(
      `SELECT b.id, b.bill_type, b.payee_name, b.account_number, b.amount, b.due_date,
              b.memo, b.confirmation_number, b.status, b.created_at, a.account_type
         FROM bills b
         JOIN accounts a ON a.id = b.from_account_id
        WHERE b.user_id = ?
        ORDER BY b.created_at DESC`
    )
    .bind(auth.sub)
    .all();

  return jsonResponse({ bills: results });
}

function generateConfirmation() {
  // e.g. PGC-4F2A9C. Display-only; uniqueness is not relied on anywhere.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const byte of bytes) suffix += chars[byte % chars.length];
  return `PGC-${suffix}`;
}
