import { authenticate, errorResponse } from './lib/auth.js';
import { handleLogin, handleRefresh, handleLogout } from './routes/auth.js';
import { handleGetAccounts, handleGetAccount } from './routes/accounts.js';
import { handleInternalTransfer, handleExternalTransfer, handleBatchTransfer, handleGetExternalBanks, handleGetTransfers } from './routes/transfers.js';
import { handleGetTransactions, handleGetTransaction } from './routes/transactions.js';
import { handleGetPayees, handleCreatePayee, handleDeletePayee, handlePayBill, handleGetBills } from './routes/bills.js';
import { handleApplyForLoan, handleGetLoans, handleGetLoan } from './routes/loans.js';
import { handleGetPlans, handleCreateInvestment, handleGetInvestments, handleWithdrawInvestment } from './routes/investments.js';
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
      if (pathname === '/api/transfers/external' && method === 'POST') return await handleExternalTransfer(request, env, auth);
      if (pathname === '/api/transfers/batch' && method === 'POST') return await handleBatchTransfer(request, env, auth);
      if (pathname === '/api/transfers/banks' && method === 'GET') return await handleGetExternalBanks(request, env, auth);
      if (pathname === '/api/transfers' && method === 'GET') return await handleGetTransfers(request, env, auth);

      if (pathname === '/api/transactions' && method === 'GET') return await handleGetTransactions(request, env, auth);

      const transactionMatch = pathname.match(/^\/api\/transactions\/([^/]+)$/);
      if (transactionMatch && method === 'GET') return await handleGetTransaction(request, env, auth, transactionMatch[1]);

      // Payee routes are matched before /api/bills/:id-style routes so that
      // "payees" is never treated as an id.
      if (pathname === '/api/bills/payees' && method === 'GET') return await handleGetPayees(request, env, auth);
      if (pathname === '/api/bills/payees' && method === 'POST') return await handleCreatePayee(request, env, auth);

      const payeeMatch = pathname.match(/^\/api\/bills\/payees\/([^/]+)$/);
      if (payeeMatch && method === 'DELETE') return await handleDeletePayee(request, env, auth, payeeMatch[1]);

      if (pathname === '/api/bills/pay' && method === 'POST') return await handlePayBill(request, env, auth);
      if (pathname === '/api/bills' && method === 'GET') return await handleGetBills(request, env, auth);

      if (pathname === '/api/loans/apply' && method === 'POST') return await handleApplyForLoan(request, env, auth);
      if (pathname === '/api/loans' && method === 'GET') return await handleGetLoans(request, env, auth);

      const loanMatch = pathname.match(/^\/api\/loans\/([^/]+)$/);
      if (loanMatch && loanMatch[1] !== 'apply' && method === 'GET') return await handleGetLoan(request, env, auth, loanMatch[1]);

      // Plans are matched before the generic collection routes so "plans" is
      // never treated as an investment id.
      if (pathname === '/api/investments/plans' && method === 'GET') return await handleGetPlans(request, env, auth);
      if (pathname === '/api/investments' && method === 'POST') return await handleCreateInvestment(request, env, auth);
      if (pathname === '/api/investments' && method === 'GET') return await handleGetInvestments(request, env, auth);

      const withdrawMatch = pathname.match(/^\/api\/investments\/([^/]+)\/withdraw$/);
      if (withdrawMatch && method === 'POST') return await handleWithdrawInvestment(request, env, auth, withdrawMatch[1]);

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
