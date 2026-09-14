/**
 * Audit-log and notification writers.
 *
 * Both are deliberately best-effort: an audit or notification failure must
 * never fail the banking operation that triggered it. A transfer that succeeded
 * but returned 500 because a log insert failed would be far worse than a
 * missing log line, so everything here swallows its own errors.
 *
 * They are also NOT part of the caller's batch() for the same reason — being in
 * the batch would mean a logging failure rolls back a completed transfer.
 *
 * Note for Phase 4: audit entries are written by the actions themselves, so the
 * log is real evidence of what happened rather than decoration. If an
 * intentional vulnerability is added that moves money, it will show up here
 * too, which is useful for the "detect the attack" half of the demo.
 */

/** Extracts caller metadata from the request for the audit trail. */
function requestContext(request) {
  return {
    // CF-Connecting-IP is set by Cloudflare on the real edge. It is absent in
    // some local dev paths, hence the fallbacks.
    ip:
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For') ||
      null,
    userAgent: request.headers.get('User-Agent') || null
  };
}

/**
 * Appends an audit entry. Never throws.
 *
 * @param {string} eventType e.g. 'login', 'transfer_internal', 'card_block'
 * @param {string} detail    human-readable summary shown in the UI
 */
export async function recordAudit(env, request, userId, eventType, detail) {
  if (!userId) return;
  try {
    const { ip, userAgent } = requestContext(request);
    await env.BANK_DB
      .prepare('INSERT INTO audit_logs (id, user_id, event_type, detail, ip_address, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), userId, eventType, detail || null, ip, userAgent, new Date().toISOString())
      .run();
  } catch (err) {
    // Intentionally swallowed — see the module comment.
  }
}

/** Creates a notification. Never throws. */
export async function notify(env, userId, type, title, message) {
  if (!userId) return;
  try {
    await env.BANK_DB
      .prepare('INSERT INTO notifications (id, user_id, type, title, message, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .bind(crypto.randomUUID(), userId, type, title, message, new Date().toISOString())
      .run();
  } catch (err) {
    // Intentionally swallowed — see the module comment.
  }
}

/** Convenience: audit + notify in one call, for events worth surfacing to the user. */
export async function recordAndNotify(env, request, userId, eventType, detail, notification) {
  await recordAudit(env, request, userId, eventType, detail);
  if (notification) {
    await notify(env, userId, notification.type, notification.title, notification.message);
  }
}
