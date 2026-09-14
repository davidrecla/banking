import { verifyPassword, signJWT, verifyJWT } from '../lib/crypto.js';
import { jsonResponse, errorResponse, authenticate } from '../lib/auth.js';
import { incrementLoginAttempts, resetLoginAttempts } from '../lib/ratelimit.js';
import { recordAudit } from '../lib/activity.js';

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
  // Unknown usernames cannot be audited against a user row, and deliberately
  // return the same message as a wrong password so the response does not reveal
  // whether the account exists.
  if (!user) return errorResponse('Invalid username or password', 401);

  const valid = await verifyPassword(password, user.password_hash, user.salt);
  if (!valid) {
    // Failed attempts are the entries that matter most in a security demo.
    await recordAudit(env, request, user.id, 'login_failed', `Failed login for ${username}`);
    return errorResponse('Invalid username or password', 401);
  }

  await resetLoginAttempts(env, username);
  await recordAudit(env, request, user.id, 'login', `Signed in as ${username}`);

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
  //
  // Logout is a public route, so the caller may or may not present a valid
  // token. Authenticate opportunistically purely so the event can be attributed
  // in the audit log; an anonymous logout is still a successful no-op.
  const auth = await authenticate(request, env);
  if (auth) await recordAudit(env, request, auth.sub, 'logout', 'Signed out');

  return jsonResponse({ message: 'Logged out' });
}
