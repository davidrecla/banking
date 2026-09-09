// Shared client-side helpers for the PGC Bank demo UI.
// Every UI action here calls the same public REST API — nothing UI-only.

const TOKEN_KEY = 'pgc_token';
const USER_KEY = 'pgc_user';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Redirect to login if not authenticated. Call at the top of protected pages. */
function requireAuth() {
  if (!getToken()) {
    window.location.href = '/';
  }
}

/** fetch() wrapper that attaches the Authorization header automatically. */
async function authFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    clearSession();
    window.location.href = '/';
    throw new Error('Unauthorized');
  }
  return res;
}

async function logout() {
  try {
    await authFetch('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    // ignore
  }
  clearSession();
  window.location.href = '/';
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast ${isError ? 'toast-error' : 'toast-success'}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}
