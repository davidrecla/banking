import { jsonResponse } from '../lib/auth.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * GET /api/audit-log
 * Query params: eventType, limit (1-100, default 50), offset
 *
 * Scoped to the caller. Note for Phase 4: an admin-visible, cross-user version
 * of this is a natural Broken Function Level Authorization target — add it as a
 * separate clearly-named endpoint rather than by loosening this one.
 */
export async function handleGetAuditLog(request, env, auth) {
  const params = new URL(request.url).searchParams;
  const limit = clampInt(params.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0);

  const conditions = ['user_id = ?'];
  const binds = [auth.sub];

  const eventType = params.get('eventType');
  if (eventType) {
    conditions.push('event_type = ?');
    binds.push(eventType);
  }

  const where = conditions.join(' AND ');

  const countRow = await env.BANK_DB
    .prepare(`SELECT COUNT(*) AS total FROM audit_logs WHERE ${where}`)
    .bind(...binds)
    .first();

  const { results } = await env.BANK_DB
    .prepare(
      `SELECT id, event_type, detail, ip_address, user_agent, created_at
         FROM audit_logs WHERE ${where}
        ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(...binds, limit, offset)
    .all();

  // The distinct event types the caller actually has, so the UI filter only
  // offers values that will return something.
  const { results: types } = await env.BANK_DB
    .prepare('SELECT DISTINCT event_type FROM audit_logs WHERE user_id = ? ORDER BY event_type')
    .bind(auth.sub)
    .all();

  const total = countRow ? countRow.total : 0;

  return jsonResponse({
    entries: results,
    eventTypes: types.map((t) => t.event_type),
    pagination: { total, limit, offset, hasMore: offset + results.length < total }
  });
}

function clampInt(raw, fallback, min, max) {
  const parsed = parseInt(raw || '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
