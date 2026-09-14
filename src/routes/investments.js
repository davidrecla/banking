import { jsonResponse, errorResponse } from '../lib/auth.js';
import { loadDebitableAccount } from '../lib/accounts.js';
import { recordAudit, recordAndNotify } from '../lib/activity.js';

const MIN_AMOUNT = 100;
const MAX_AMOUNT = 5000;

/**
 * The four available plans. `annualRate` is a nominal projection used by the
 * return calculator — nothing here models real market behaviour.
 * `durations` lists the selectable terms in months.
 */
export const PLANS = {
  money_market: {
    name: 'Money Market Fund',
    annualRate: 3.25,
    risk: 'Low',
    durations: [3, 6, 12],
    description: 'Short-term, highly liquid holdings. Lowest risk, modest return.'
  },
  fixed_deposit: {
    name: 'Fixed Deposit',
    annualRate: 4.5,
    risk: 'Low',
    durations: [6, 12, 24],
    description: 'Locked for a fixed term at a guaranteed rate.'
  },
  balanced_fund: {
    name: 'Balanced Fund',
    annualRate: 6.75,
    risk: 'Medium',
    durations: [12, 24, 36],
    description: 'Mixed equity and bond exposure for moderate growth.'
  },
  growth_equity: {
    name: 'Growth Equity',
    annualRate: 9.5,
    risk: 'High',
    durations: [12, 36, 60],
    description: 'Equity-weighted for long-horizon growth. Highest volatility.'
  }
};

/** Simple interest projection. Mirrored in public/investments.html. */
export function projectedReturnFor(amount, durationMonths, annualRatePct) {
  const gain = amount * (annualRatePct / 100) * (durationMonths / 12);
  return Math.round((amount + gain) * 100) / 100;
}

/** GET /api/investments/plans — public plan catalogue (still requires auth). */
export async function handleGetPlans(request, env, auth) {
  const plans = Object.entries(PLANS).map(([key, plan]) => ({
    planType: key,
    name: plan.name,
    annualRate: plan.annualRate,
    risk: plan.risk,
    durations: plan.durations,
    description: plan.description,
    minAmount: MIN_AMOUNT,
    maxAmount: MAX_AMOUNT
  }));

  return jsonResponse({ plans });
}

/**
 * POST /api/investments
 * body { fromAccountId, planType, amount, durationMonths }
 *
 * Debits the funding account and records the holding.
 */
export async function handleCreateInvestment(request, env, auth) {
  const body = await request.json().catch(() => null);
  const { fromAccountId, planType, amount, durationMonths } = body || {};

  if (!fromAccountId || !planType || !amount || !durationMonths) {
    return errorResponse('fromAccountId, planType, amount and durationMonths are required', 400);
  }

  const plan = PLANS[planType];
  if (!plan) {
    return errorResponse(`planType must be one of: ${Object.keys(PLANS).join(', ')}`, 400);
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return errorResponse('amount must be a positive number', 400);
  }
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    return errorResponse(`Investment amount must be between $${MIN_AMOUNT} and $${MAX_AMOUNT}`, 400);
  }
  if (!plan.durations.includes(durationMonths)) {
    return errorResponse(`durationMonths for ${plan.name} must be one of: ${plan.durations.join(', ')}`, 400);
  }

  const source = await loadDebitableAccount(env, auth, fromAccountId, 'Source account not found');
  if (source.response) return source.response;
  const account = source.account;
  if (account.balance < amount) return errorResponse('Insufficient funds', 400);

  const projectedReturn = projectedReturnFor(amount, durationMonths, plan.annualRate);
  const now = new Date();
  const maturity = new Date(now);
  maturity.setMonth(maturity.getMonth() + durationMonths);

  const investmentId = crypto.randomUUID();
  const nowIso = now.toISOString();

  await env.BANK_DB.batch([
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').bind(amount, account.id),
    env.BANK_DB
      .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), account.id, 'investment_purchase', amount, `PGC ${plan.name}`, 'investment', 'completed', `${plan.name} purchase (${durationMonths} months)`, nowIso),
    env.BANK_DB
      .prepare('INSERT INTO investments (id, user_id, from_account_id, plan_type, amount, duration_months, annual_rate, projected_return, maturity_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(investmentId, auth.sub, account.id, planType, amount, durationMonths, plan.annualRate, projectedReturn, maturity.toISOString(), 'active', nowIso)
  ]);

  await recordAndNotify(
    env,
    request,
    auth.sub,
    'investment_purchase',
    `Invested $${amount.toFixed(2)} in ${plan.name} for ${durationMonths} months at ${plan.annualRate}%`,
    {
      type: 'account',
      title: 'Investment created',
      message: `$${amount.toFixed(2)} invested in ${plan.name}. Projected value $${projectedReturn.toFixed(2)} at maturity.`
    }
  );

  return jsonResponse({
    message: 'Investment created',
    investment: {
      id: investmentId,
      planType,
      planName: plan.name,
      amount,
      durationMonths,
      annualRate: plan.annualRate,
      projectedReturn,
      maturityDate: maturity.toISOString(),
      status: 'active',
      createdAt: nowIso
    },
    newBalance: account.balance - amount
  }, 201);
}

/** GET /api/investments — the caller's holdings, newest first. */
export async function handleGetInvestments(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare(
      `SELECT i.id, i.plan_type, i.amount, i.duration_months, i.annual_rate,
              i.projected_return, i.maturity_date, i.status, i.withdrawn_at,
              i.created_at, a.account_type
         FROM investments i
         JOIN accounts a ON a.id = i.from_account_id
        WHERE i.user_id = ?
        ORDER BY i.created_at DESC`
    )
    .bind(auth.sub)
    .all();

  const investments = results.map((row) => ({
    ...row,
    plan_name: PLANS[row.plan_type] ? PLANS[row.plan_type].name : row.plan_type
  }));

  return jsonResponse({ investments });
}

/**
 * POST /api/investments/:id/withdraw
 *
 * Pays back into the original funding account. Withdrawing before the maturity
 * date returns the principal only; at or after maturity it returns the
 * projected value.
 */
export async function handleWithdrawInvestment(request, env, auth, investmentId) {
  const investment = await env.BANK_DB
    .prepare('SELECT * FROM investments WHERE id = ? AND user_id = ?')
    .bind(investmentId, auth.sub)
    .first();

  if (!investment) return errorResponse('Investment not found', 404);
  if (investment.status === 'withdrawn') return errorResponse('Investment has already been withdrawn', 400);

  const now = new Date();
  const matured = now >= new Date(investment.maturity_date);
  const payout = matured ? investment.projected_return : investment.amount;
  const nowIso = now.toISOString();

  await env.BANK_DB.batch([
    env.BANK_DB.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').bind(payout, investment.from_account_id),
    env.BANK_DB
      .prepare('UPDATE investments SET status = ?, withdrawn_at = ? WHERE id = ?')
      .bind('withdrawn', nowIso, investment.id),
    env.BANK_DB
      .prepare('INSERT INTO transactions (id, account_id, type, amount, merchant, category, status, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), investment.from_account_id, 'deposit', payout, 'PGC Investment Withdrawal', 'investment', 'completed', matured ? 'Matured investment payout' : 'Early withdrawal (principal only)', nowIso)
  ]);

  await recordAudit(
    env,
    request,
    auth.sub,
    'investment_withdraw',
    `Withdrew ${matured ? 'matured' : 'early (principal only)'} investment, payout $${payout.toFixed(2)}`
  );

  return jsonResponse({
    message: matured ? 'Investment withdrawn at maturity' : 'Early withdrawal: principal returned, projected gains forfeited',
    payout,
    matured
  });
}
