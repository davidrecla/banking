import { authenticate, errorResponse } from './lib/auth.js';
import { handleLogin, handleRefresh, handleLogout } from './routes/auth.js';
import { handleGetAccounts, handleGetAccount, handleFreezeAccount, handleUnfreezeAccount } from './routes/accounts.js';
import { handleGetCards, handleBlockCard, handleUnblockCard } from './routes/cards.js';
import { handleInternalTransfer, handleExternalTransfer, handleBatchTransfer, handleGetExternalBanks, handleGetTransfers } from './routes/transfers.js';
import { handleGetTransactions, handleGetTransaction } from './routes/transactions.js';
import { handleGetPayees, handleCreatePayee, handleDeletePayee, handlePayBill, handleGetBills } from './routes/bills.js';
import { handleApplyForLoan, handleGetLoans, handleGetLoan } from './routes/loans.js';
import { handleGetPlans, handleCreateInvestment, handleGetInvestments, handleWithdrawInvestment } from './routes/investments.js';
import { handleGenerateStatement, handleGetStatements, handleDownloadStatement } from './routes/statements.js';
import { handleGetNotifications, handleMarkNotificationRead, handleMarkAllNotificationsRead } from './routes/notifications.js';
import { handleGetAuditLog } from './routes/audit.js';
import { handleUploadFile, handleListUploads, handleDownloadUpload, handleDeleteUpload } from './routes/uploads.js';
// Intentionally vulnerable Phase 4 showcase endpoints — see src/routes/vulnerable.js
// header for why these exist and must not be "fixed".
import { handleGetUserBalance, handleInternalDebug, handleGetProfile, handleExpressTransfer, handleAdminListUsers, handleAdminForceApproveLoan, handleAvatarFromUrl, handleDebugParse, handleV1Accounts } from './routes/vulnerable.js';

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

      // API2 demo endpoint: deliberately unauthenticated (see vulnerable.js).
      if (pathname === '/api/internal/debug' && method === 'GET') return await handleInternalDebug(env);

      // --- Protected routes (require valid JWT) ---
      const auth = await authenticate(request, env);
      if (!auth) return errorResponse('Unauthorized', 401);

      if (pathname === '/api/accounts' && method === 'GET') return await handleGetAccounts(request, env, auth);

      const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (accountMatch && method === 'GET') return await handleGetAccount(request, env, auth, accountMatch[1]);

      const freezeMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/(freeze|unfreeze)$/);
      if (freezeMatch && method === 'POST') {
        return freezeMatch[2] === 'freeze'
          ? await handleFreezeAccount(request, env, auth, freezeMatch[1])
          : await handleUnfreezeAccount(request, env, auth, freezeMatch[1]);
      }

      if (pathname === '/api/cards' && method === 'GET') return await handleGetCards(request, env, auth);

      const cardMatch = pathname.match(/^\/api\/cards\/([^/]+)\/(block|unblock)$/);
      if (cardMatch && method === 'POST') {
        return cardMatch[2] === 'block'
          ? await handleBlockCard(request, env, auth, cardMatch[1])
          : await handleUnblockCard(request, env, auth, cardMatch[1]);
      }

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

      if (pathname === '/api/statements/generate' && method === 'POST') return await handleGenerateStatement(request, env, auth);
      if (pathname === '/api/statements' && method === 'GET') return await handleGetStatements(request, env, auth);

      const statementDownloadMatch = pathname.match(/^\/api\/statements\/([^/]+)\/download$/);
      if (statementDownloadMatch && method === 'GET') return await handleDownloadStatement(request, env, auth, statementDownloadMatch[1]);

      if (pathname === '/api/notifications' && method === 'GET') return await handleGetNotifications(request, env, auth);
      // Matched before the /:id/read pattern so "read-all" is never read as an id.
      if (pathname === '/api/notifications/read-all' && method === 'POST') return await handleMarkAllNotificationsRead(request, env, auth);

      const notificationReadMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (notificationReadMatch && method === 'POST') return await handleMarkNotificationRead(request, env, auth, notificationReadMatch[1]);

      if (pathname === '/api/audit-log' && method === 'GET') return await handleGetAuditLog(request, env, auth);

      if (pathname === '/api/uploads' && method === 'POST') return await handleUploadFile(request, env, auth);
      if (pathname === '/api/uploads' && method === 'GET') return await handleListUploads(request, env, auth);

      const uploadMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);
      if (uploadMatch && method === 'GET') return await handleDownloadUpload(request, env, auth, uploadMatch[1]);
      if (uploadMatch && method === 'DELETE') return await handleDeleteUpload(request, env, auth, uploadMatch[1]);

      // --- Phase 4 intentionally vulnerable showcase endpoints ---

      if (pathname === '/api/profile' && method === 'GET') return await handleGetProfile(request, env, auth);
      if (pathname === '/api/profile/avatar-from-url' && method === 'POST') return await handleAvatarFromUrl(request, env, auth);
      if (pathname === '/api/transfers/express' && method === 'POST') return await handleExpressTransfer(request, env, auth);
      if (pathname === '/api/admin/users' && method === 'GET') return await handleAdminListUsers(request, env, auth);
      if (pathname === '/api/debug/parse' && method === 'POST') return await handleDebugParse(request, env, auth);
      if (pathname === '/api/v1/accounts' && method === 'GET') return await handleV1Accounts(request, env, auth);

      const userBalanceMatch = pathname.match(/^\/api\/users\/([^/]+)\/balance$/);
      if (userBalanceMatch && method === 'GET') return await handleGetUserBalance(request, env, auth, userBalanceMatch[1]);

      const forceApproveMatch = pathname.match(/^\/api\/admin\/loans\/([^/]+)\/force-approve$/);
      if (forceApproveMatch && method === 'POST') return await handleAdminForceApproveLoan(request, env, auth, forceApproveMatch[1]);

      return errorResponse('Not found', 404);
    } catch (err) {
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  }
};
