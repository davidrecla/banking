import { verifyJWT } from './crypto.js';

/**
 * Extracts and verifies the Bearer JWT from a request's Authorization header.
 * Returns the decoded payload (e.g. { sub, username, role }) or null if
 * missing/invalid/expired.
 */
export async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  try {
    return await verifyJWT(match[1], env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extraHeaders }
  });
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}
