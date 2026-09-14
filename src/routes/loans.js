import { jsonResponse, errorResponse } from '../lib/auth.js';

const MIN_AMOUNT = 500;
const MAX_AMOUNT = 10000;
const AUTO_APPROVE_BELOW = 2000;
const TERMS = [6, 12, 24, 36, 48, 60];

const EMPLOYMENT_STATUSES = ['employed', 'self_employed', 'contract', 'retired', 'student'];

/**
 * Rate depends on term length only — longer terms price higher. Deliberately
 * simple and deterministic so the UI calculator can mirror it exactly.
 */
export function interestRateFor(termMonths) {
  if (termMonths <= 12) return 5.5;
  if (termMonths <= 24) return 6.5;
  if (termMonths <= 36) return 7.5;
  if (termMonths <= 48) return 8.5;
  return 9.5;
}

/** Standard amortising payment. Mirrored in public/loans.html. */
export function monthlyPaymentFor(amount, termMonths, annualRatePct) {
  const monthlyRate = annualRatePct / 100 / 12;
  const payment =
    (amount * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) /
    (Math.pow(1 + monthlyRate, termMonths) - 1);
  return Math.round(payment * 100) / 100;
}

/**
 * POST /api/loans/apply
 * body { amount, termMonths, purpose?, employmentStatus?, annualIncome?, disburseAccountId? }
 *
 * Loans under $2000 auto-approve and disburse immediately; $2000 and above are
 * held as pending_review and disburse nothing.
 */
export async function handleApplyForLoan(request, env, auth) {
  const body = await request.json().catch(() => null);
  const { amount, termMonths, purpose, employmentStatus, annualIncome, disburseAccountId } = body || {};

  if (!amount || !termMonths) {
    return errorResponse('amount and termMonths are required', 400);
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return errorResponse('amount must be a positive number', 400);
  }
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    return errorResponse(`Loan amount must be between $${MIN_AMOUNT} and $${MAX_AMOUNT}`, 400);
  }
  if (!TERMS.includes(termMonths)) {
    return errorResponse(`termMonths must be one of: ${TERMS.join(', ')}`, 400);
  }
  if (employmentStatus && !EMPLOYMENT_STATUSES.includes(employmentStatus)) {
    return errorResponse(`employmentStatus must be one of: ${EMPLOYMENT_STATUSES.join(', ')}`, 400);
  }
  if (annualIncome !== undefined && (typeof annualIncome !== 'number' || annualIncome < 0)) {
    return errorResponse('annualIncome must be a non-negative number', 400);
  }

  const autoApproved = amount < AUTO_APPROVE_BELOW;
  const status = autoApproved ? 'approved' : 'pending_review';

  // An account is only needed when the loan will actually disburse.
  let account = null;
  if (autoApproved) {
    if (!disburseAccountId) {
      return errorResponse('disburseAccountId is required for loans under $2000, which disburse immediately', 400);
    }
    account = await env.BANK_DB
      .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
      .bind(disburseAccountId, auth.sub)
      .first();
    if (!account) return errorResponse('Disbursement account not found', 404);
  } else if (disburseAccountId) {
    // Validate ownership even when not disbursing, so a pending loan can't be
    // recorded against someone else's account.
    account = await env.BANK_DB
      .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
      .bind(disburseAccountId, auth.sub)
      .first();
    if (!account) return errorResponse('Disbursement account not found', 404);
  }

  const interestRate = interestRateFor(termMonths);
  const monthlyPayment = monthlyPaymentFor(amount, termMonths, interestRate);
  const loanId = crypto.randomUUID();
  const now = new Date().toISOString();

  const statements = [
    env.BANK_DB
      .prepare('INSERT INTO loans (id, user_id, disburse_account_id, amount, term_months, purpose, employment_status, annual_income, interest_rate, monthly_payment, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(loanId, auth.sub, account ? account.id : null, amount, termMonths, purpose || null, employmentStatus || null, annualIncome ?? null, interestRate, monthlyPayment, status, now)
  ];

  if (autoApproved) {
    statements.push(
      env.BANK_DB.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').bind(amount, account.id),
      env.BANK_DB
        .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), account.id, 'deposit', amount, 'PGC Bank Loan Disbursement', 'loan', 'completed', `Loan disbursement (${termMonths} months @ ${interestRate}%)`, now)
    );
  }

  await env.BANK_DB.batch(statements);

  return jsonResponse({
    message: autoApproved
      ? 'Loan approved and disbursed'
      : `Loan applications of $${AUTO_APPROVE_BELOW} or more require manual review`,
    loan: {
      id: loanId,
      amount,
      termMonths,
      interestRate,
      monthlyPayment,
      totalRepayment: Math.round(monthlyPayment * termMonths * 100) / 100,
      status,
      createdAt: now
    },
    ...(autoApproved ? { newBalance: account.balance + amount } : {})
  }, 201);
}

/** GET /api/loans — the caller's loans, newest first. */
export async function handleGetLoans(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare(
      `SELECT id, amount, term_months, purpose, employment_status, annual_income,
              interest_rate, monthly_payment, status, created_at
         FROM loans WHERE user_id = ? ORDER BY created_at DESC`
    )
    .bind(auth.sub)
    .all();

  return jsonResponse({ loans: results });
}

/** GET /api/loans/:id — ownership-checked. */
export async function handleGetLoan(request, env, auth, loanId) {
  const loan = await env.BANK_DB
    .prepare(
      `SELECT id, amount, term_months, purpose, employment_status, annual_income,
              interest_rate, monthly_payment, status, created_at
         FROM loans WHERE id = ? AND user_id = ?`
    )
    .bind(loanId, auth.sub)
    .first();

  if (!loan) return errorResponse('Loan not found', 404);
  return jsonResponse({ loan });
}
