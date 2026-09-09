import { authenticate, errorResponse } from './lib/auth.js';
import { handleLogin, handleRefresh, handleLogout } from './routes/auth.js';
import { handleGetAccounts, handleGetAccount } from './routes/accounts.js';
import { handleInternalTransfer } from './routes/transfers.js';
import { handleUploadFile, handleListUploads, handleDownloadUpload, handleDeleteUpload } from './routes/uploads.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (!pathname.startsWith('/api/')) {
      // Non-API requests are served by Workers Assets (see [assets] in
      // wrangler.toml); if we reach here, no matching static file exists.
      return new Response('Not found', { status: 404 });
    }

    try {
      // --- Public routes (no auth) ---
      if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(request, env);
      if (pathname === '/api/auth/refresh' && method === 'POST') return await handleRefresh(request, env);
      if (pathname === '/api/auth/logout' && method === 'POST') return await handleLogout(request, env);

      // --- Protected routes (require valid JWT) ---
      const auth = await authenticate(request, env);
      if (!auth) return errorResponse('Unauthorized', 401);

      if (pathname === '/api/accounts' && method === 'GET') return await handleGetAccounts(request, env, auth);

      const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (accountMatch && method === 'GET') return await handleGetAccount(request, env, auth, accountMatch[1]);

      if (pathname === '/api/transfers/internal' && method === 'POST') return await handleInternalTransfer(request, env, auth);

      if (pathname === '/api/uploads' && method === 'POST') return await handleUploadFile(request, env, auth);
      if (pathname === '/api/uploads' && method === 'GET') return await handleListUploads(request, env, auth);

      const uploadMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);
      if (uploadMatch && method === 'GET') return await handleDownloadUpload(request, env, auth, uploadMatch[1]);
      if (uploadMatch && method === 'DELETE') return await handleDeleteUpload(request, env, auth, uploadMatch[1]);

      return errorResponse('Not found', 404);
    } catch (err) {
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  }
};
