import { jsonResponse, errorResponse } from '../lib/auth.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * GET /api/notifications
 * Query params: unreadOnly=true, limit (1-100, default 50)
 *
 * Always returns unreadCount alongside the rows so the nav badge does not need
 * a second request.
 */
export async function handleGetNotifications(request, env, auth) {
  const params = new URL(request.url).searchParams;
  const unreadOnly = params.get('unreadOnly') === 'true';
  const limit = clampInt(params.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);

  const where = unreadOnly ? 'user_id = ? AND read = 0' : 'user_id = ?';

  const { results } = await env.BANK_DB
    .prepare(
      `SELECT id, type, title, message, read, created_at
         FROM notifications WHERE ${where}
        ORDER BY created_at DESC LIMIT ?`
    )
    .bind(auth.sub, limit)
    .all();

  const countRow = await env.BANK_DB
    .prepare('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read = 0')
    .bind(auth.sub)
    .first();

  return jsonResponse({
    notifications: results,
    unreadCount: countRow ? countRow.unread : 0
  });
}

/** POST /api/notifications/:id/read */
export async function handleMarkNotificationRead(request, env, auth, notificationId) {
  const notification = await env.BANK_DB
    .prepare('SELECT id, read FROM notifications WHERE id = ? AND user_id = ?')
    .bind(notificationId, auth.sub)
    .first();
  if (!notification) return errorResponse('Notification not found', 404);

  if (notification.read) {
    return jsonResponse({ message: 'Already read', id: notificationId });
  }

  await env.BANK_DB.prepare('UPDATE notifications SET read = 1 WHERE id = ?').bind(notificationId).run();
  return jsonResponse({ message: 'Marked as read', id: notificationId });
}

/** POST /api/notifications/read-all */
export async function handleMarkAllNotificationsRead(request, env, auth) {
  const result = await env.BANK_DB
    .prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0')
    .bind(auth.sub)
    .run();

  // D1 reports the row count under meta.changes.
  const updated = result && result.meta ? result.meta.changes : 0;
  return jsonResponse({ message: `Marked ${updated} notification(s) as read`, updated });
}

function clampInt(raw, fallback, min, max) {
  const parsed = parseInt(raw || '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
