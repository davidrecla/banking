import { jsonResponse, errorResponse } from '../lib/auth.js';
import { getDailyTransferTotal, addDailyTransferTotal } from '../lib/ratelimit.js';
import { loadDebitableAccount } from '../lib/accounts.js';
import { recordAudit, recordAndNotify, notify } from '../lib/activity.js';

const MAX_PER_TRANSACTION = 500;
const MAX_PER_DAY = 1000;

const EXTERNAL_MAX_PER_TRANSACTION = 1000;
const EXTERNAL_FEE = 2.5;
const BATCH_MAX_ITEMS = 10;

/**
 * Mock partner banks. `code` is what callers send; nothing here talks to a real
 * external system — the "settlement" is simulated locally.
 */
export const EXTERNAL_BANKS = [
  { code: 'FNB', name: 'First National Bank' },
  { code: 'MTB', name: 'Metro Trust Bank' },
  { code: 'PCU', name: 'Pacific Credit Union' },
  { code: 'SVB', name: 'Summit Valley Bank' },
  { code: 'HRZ', name: 'Horizon Financial' }
];

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

  await recordAudit(
    env,
    request,
    auth.sub,
    'transfer_internal',
    `Sent $${amount.toFixed(2)} to ${toUser.username} (${toAccount.account_type})`
  );
  // The recipient is a different user, so they get the notification, not the sender.
  await notify(
    env,
    toUser.id,
    'transaction',
    'Money received',
    `${auth.username} sent you $${amount.toFixed(2)} to your ${toAccount.account_type} account.`
  );

  return jsonResponse({
    message: 'Transfer completed',
    from: { accountId: fromAccount.id, newBalance: fromAccount.balance - amount },
    to: { username: toUser.username, accountType: toAccount.account_type }
  });
}

/** GET /api/transfers/banks — the mock partner bank list for the UI dropdown. */
export async function handleGetExternalBanks(request, env, auth) {
  return jsonResponse({
    banks: EXTERNAL_BANKS,
    maxPerTransaction: EXTERNAL_MAX_PER_TRANSACTION,
    fee: EXTERNAL_FEE
  });
}

/**
 * POST /api/transfers/external
 * body { fromAccountId, bankCode, accountNumber, accountName, amount, note? }
 *
 * Capped at $1000 per transaction with a flat $2.50 fee. The amount and the fee
 * are both debited. Recorded in `transfers` (which holds the destination-bank
 * detail) as well as `transactions`.
 */
export async function handleExternalTransfer(request, env, auth) {
  const body = await request.json().catch(() => null);
  const { fromAccountId, bankCode, accountNumber, accountName, amount, note } = body || {};

  if (!fromAccountId || !bankCode || !accountNumber || !accountName || !amount) {
    return errorResponse('fromAccountId, bankCode, accountNumber, accountName and amount are required', 400);
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return errorResponse('amount must be a positive number', 400);
  }
  if (amount > EXTERNAL_MAX_PER_TRANSACTION) {
    return errorResponse(`External transfers are limited to $${EXTERNAL_MAX_PER_TRANSACTION} per transaction`, 400);
  }

  const bank = EXTERNAL_BANKS.find((b) => b.code === bankCode);
  if (!bank) {
    return errorResponse(`bankCode must be one of: ${EXTERNAL_BANKS.map((b) => b.code).join(', ')}`, 400);
  }

  const source = await loadDebitableAccount(env, auth, fromAccountId, 'Source account not found');
  if (source.response) return source.response;
  const account = source.account;

  const totalDebit = amount + EXTERNAL_FEE;
  if (account.balance < totalDebit) {
    return errorResponse(`Insufficient funds (transfer $${amount} plus $${EXTERNAL_FEE} fee)`, 400);
  }

  const now = new Date().toISOString();
  const transferId = crypto.randomUUID();
  const referenceNumber = generateReference();

  await env.BANK_DB.batch([
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').bind(totalDebit, account.id),
    env.BANK_DB
      .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), account.id, 'transfer_out', totalDebit, `${bank.name} - ${accountName}`, 'external_transfer', 'completed', note || `External transfer to ${bank.name}`, now),
    env.BANK_DB
      .prepare('INSERT INTO transfers (id, user_id, from_account_id, to_account_id, external_bank, external_account_number, external_account_name, amount, fee, note, reference_number, batch_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(transferId, auth.sub, account.id, null, bank.name, accountNumber, accountName, amount, EXTERNAL_FEE, note || null, referenceNumber, null, 'completed', now)
  ]);

  await recordAndNotify(
    env,
    request,
    auth.sub,
    'transfer_external',
    `Sent $${amount.toFixed(2)} to ${accountName} at ${bank.name} (ref ${referenceNumber})`,
    {
      type: 'transaction',
      title: 'External transfer sent',
      message: `$${amount.toFixed(2)} sent to ${accountName} at ${bank.name}. Reference ${referenceNumber}.`
    }
  );

  return jsonResponse({
    message: 'External transfer submitted',
    transfer: {
      id: transferId,
      bank: bank.name,
      accountNumber,
      accountName,
      amount,
      fee: EXTERNAL_FEE,
      totalDebited: totalDebit,
      referenceNumber,
      status: 'completed',
      createdAt: now
    },
    newBalance: account.balance - totalDebit
  }, 201);
}

/**
 * POST /api/transfers/batch
 * body { fromAccountId, transfers: [{ bankCode, accountNumber, accountName, amount, note? }] }
 *
 * Up to 10 external transfers debited from one account under a shared batch id.
 * Validated as a whole first: if any item is invalid, or the combined total
 * exceeds the balance, nothing is written. Per-item and per-transaction caps
 * still apply to each entry.
 */
export async function handleBatchTransfer(request, env, auth) {
  const body = await request.json().catch(() => null);
  const { fromAccountId, transfers } = body || {};

  if (!fromAccountId || !Array.isArray(transfers) || transfers.length === 0) {
    return errorResponse('fromAccountId and a non-empty transfers array are required', 400);
  }
  if (transfers.length > BATCH_MAX_ITEMS) {
    return errorResponse(`A batch may contain at most ${BATCH_MAX_ITEMS} transfers`, 400);
  }

  const source = await loadDebitableAccount(env, auth, fromAccountId, 'Source account not found');
  if (source.response) return source.response;
  const account = source.account;

  // Validate every item before writing anything, so a bad entry halfway down
  // the list cannot leave a partially-applied batch.
  const validated = [];
  for (let i = 0; i < transfers.length; i++) {
    const item = transfers[i] || {};
    const label = `transfers[${i}]`;

    if (!item.bankCode || !item.accountNumber || !item.accountName || !item.amount) {
      return errorResponse(`${label}: bankCode, accountNumber, accountName and amount are required`, 400);
    }
    if (typeof item.amount !== 'number' || item.amount <= 0) {
      return errorResponse(`${label}: amount must be a positive number`, 400);
    }
    if (item.amount > EXTERNAL_MAX_PER_TRANSACTION) {
      return errorResponse(`${label}: exceeds the $${EXTERNAL_MAX_PER_TRANSACTION} per-transfer limit`, 400);
    }
    const bank = EXTERNAL_BANKS.find((b) => b.code === item.bankCode);
    if (!bank) {
      return errorResponse(`${label}: bankCode must be one of: ${EXTERNAL_BANKS.map((b) => b.code).join(', ')}`, 400);
    }
    validated.push({ ...item, bank });
  }

  const totalAmount = validated.reduce((sum, t) => sum + t.amount, 0);
  const totalFees = EXTERNAL_FEE * validated.length;
  const totalDebit = totalAmount + totalFees;

  if (account.balance < totalDebit) {
    return errorResponse(
      `Insufficient funds for batch (transfers $${totalAmount} plus $${totalFees} in fees = $${totalDebit})`,
      400
    );
  }

  const now = new Date().toISOString();
  const batchId = crypto.randomUUID();
  const statements = [
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').bind(totalDebit, account.id)
  ];
  const results = [];

  for (const item of validated) {
    const transferId = crypto.randomUUID();
    const referenceNumber = generateReference();

    statements.push(
      env.BANK_DB
        .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), account.id, 'transfer_out', item.amount + EXTERNAL_FEE, `${item.bank.name} - ${item.accountName}`, 'external_transfer', 'completed', item.note || `Batch transfer to ${item.bank.name}`, now),
      env.BANK_DB
        .prepare('INSERT INTO transfers (id, user_id, from_account_id, to_account_id, external_bank, external_account_number, external_account_name, amount, fee, note, reference_number, batch_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(transferId, auth.sub, account.id, null, item.bank.name, item.accountNumber, item.accountName, item.amount, EXTERNAL_FEE, item.note || null, referenceNumber, batchId, 'completed', now)
    );

    results.push({
      id: transferId,
      bank: item.bank.name,
      accountName: item.accountName,
      amount: item.amount,
      fee: EXTERNAL_FEE,
      referenceNumber
    });
  }

  await env.BANK_DB.batch(statements);

  await recordAndNotify(
    env,
    request,
    auth.sub,
    'transfer_batch',
    `Submitted a batch of ${results.length} external transfers totalling $${totalDebit.toFixed(2)}`,
    {
      type: 'transaction',
      title: 'Batch transfer sent',
      message: `${results.length} transfers totalling $${totalDebit.toFixed(2)} (including fees) were sent.`
    }
  );

  return jsonResponse({
    message: `Batch of ${results.length} transfers submitted`,
    batchId,
    totalAmount,
    totalFees,
    totalDebited: totalDebit,
    transfers: results,
    newBalance: account.balance - totalDebit
  }, 201);
}

/** GET /api/transfers — external/batch transfer history for the caller. */
export async function handleGetTransfers(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare(
      `SELECT t.id, t.external_bank, t.external_account_number, t.external_account_name,
              t.amount, t.fee, t.note, t.reference_number, t.batch_id, t.status,
              t.created_at, a.account_type
         FROM transfers t
         JOIN accounts a ON a.id = t.from_account_id
        WHERE t.user_id = ?
        ORDER BY t.created_at DESC`
    )
    .bind(auth.sub)
    .all();

  return jsonResponse({ transfers: results });
}

function generateReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const byte of bytes) suffix += chars[byte % chars.length];
  return `TRF-${suffix}`;
}
