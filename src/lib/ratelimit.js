/**
 * Simple fixed-window counters backed by KV.
 * Not perfectly atomic under heavy concurrency (KV has no native increment),
 * but sufficient for demo-scale traffic.
 */

/** Increments the login-attempt counter for a username; returns the new count. */
export async function incrementLoginAttempts(env, username) {
  const key = `ratelimit:login:${username}`;
  const current = parseInt((await env.BANK_KV.get(key)) || '0', 10);
  const next = current + 1;
  await env.BANK_KV.put(key, String(next), { expirationTtl: 60 });
  return next;
}

export async function resetLoginAttempts(env, username) {
  await env.BANK_KV.delete(`ratelimit:login:${username}`);
}

/** Returns today's cumulative internal-transfer total (USD) for a user. */
export async function getDailyTransferTotal(env, userId) {
  const key = `ratelimit:transfer:${userId}:${todayKey()}`;
  return parseFloat((await env.BANK_KV.get(key)) || '0');
}

/** Adds `amount` to today's cumulative internal-transfer total for a user. */
export async function addDailyTransferTotal(env, userId, amount) {
  const key = `ratelimit:transfer:${userId}:${todayKey()}`;
  const current = await getDailyTransferTotal(env, userId);
  const next = current + amount;
  // Expire well after midnight UTC to avoid unbounded growth.
  await env.BANK_KV.put(key, String(next), { expirationTtl: 60 * 60 * 26 });
  return next;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
