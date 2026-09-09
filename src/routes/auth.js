import { verifyPassword, signJWT, verifyJWT } from '../lib/crypto.js';
import { jsonResponse, errorResponse } from '../lib/auth.js';
import { incrementLoginAttempts, resetLoginAttempts } from '../lib/ratelimit.js';

const LOGIN_ATTEMPT_LIMIT = 5;
const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.username || !body.password) {
    return errorResponse('username and password are required', 400);
  }
  const { username, password } = body;

  const attempts = await incrementLoginAttempts(env, username);
  if (attempts > LOGIN_ATTEMPT_LIMIT) {
    return errorResponse('Too many login attempts. Try again in a minute.', 429);
  }

  const user = await env.BANK_DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) return errorResponse('Invalid username or password', 401);

  const valid = await verifyPassword(password, user.password_hash, user.salt);
  if (!valid) return errorResponse('Invalid username or password', 401);

  await resetLoginAttempts(env, username);

  const token = await signJWT(
    { sub: user.id, username: user.username, role: user.role },
    env.JWT_SECRET,
    TOKEN_TTL_SECONDS
  );

  return jsonResponse({
    token,
    expiresIn: TOKEN_TTL_SECONDS,
    user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role }
  });
}

export async function handleRefresh(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.token) return errorResponse('token is required', 400);

  let payload;
  try {
    payload = await verifyJWT(body.token, env.JWT_SECRET);
  } catch (err) {
    return errorResponse('Invalid or expired token', 401);
  }

  const newToken = await signJWT(
    { sub: payload.sub, username: payload.username, role: payload.role },
    env.JWT_SECRET,
    TOKEN_TTL_SECONDS
  );

  return jsonResponse({ token: newToken, expiresIn: TOKEN_TTL_SECONDS });
}

export async function handleLogout(request, env) {
  // Stateless JWTs: nothing to invalidate server-side for this demo.
  // (A production system would blacklist the token's jti in KV until expiry.)
  return jsonResponse({ message: 'Logged out' });
}
