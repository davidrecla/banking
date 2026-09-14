import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { jsonResponse, errorResponse } from '../lib/auth.js';
import { recordAudit } from '../lib/activity.js';

// DBS-inspired brand red, matching --dbs-red in public/styles.css.
const BRAND_RED = rgb(0.847, 0.122, 0.122);
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.282, 0.282, 0.282);

const CREDIT_TYPES = ['deposit', 'transfer_in'];
const FORMATS = ['pdf', 'csv'];

/**
 * Builds the statement dataset: the account, its transactions in the window,
 * and the totals. Shared by both output formats so the PDF and the CSV can
 * never disagree about the numbers.
 */
async function collectStatementData(env, auth, accountId, from, to) {
  const account = await env.BANK_DB
    .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
    .bind(accountId, auth.sub)
    .first();
  if (!account) return { error: 'Account not found', status: 404 };

  const user = await env.BANK_DB
    .prepare('SELECT full_name, username FROM users WHERE id = ?')
    .bind(auth.sub)
    .first();

  const toBound = to.length === 10 ? `${to}T23:59:59.999Z` : to;

  const { results } = await env.BANK_DB
    .prepare(
      `SELECT type, amount, merchant, category, status, description, created_at
         FROM transactions
        WHERE account_id = ? AND created_at >= ? AND created_at <= ?
        ORDER BY created_at ASC`
    )
    .bind(accountId, from, toBound)
    .all();

  // Only settled rows count toward the totals, matching how balances are
  // derived everywhere else in the app.
  let credits = 0;
  let debits = 0;
  for (const row of results) {
    if (row.status !== 'completed') continue;
    if (CREDIT_TYPES.includes(row.type)) credits += row.amount;
    else debits += row.amount;
  }

  // Opening balance is derived from everything that settled BEFORE the window,
  // not taken from accounts.balance. Using the current balance would be wrong
  // for any statement whose window ended in the past, and it is only correct by
  // accident when the window happens to cover all history. This works because
  // the ledger reconciles (see BUILD-PLAN.md "The ledger reconciles").
  const openingRow = await env.BANK_DB
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('deposit','transfer_in') THEN amount ELSE -amount END), 0) AS opening
         FROM transactions
        WHERE account_id = ? AND status = 'completed' AND created_at < ?`
    )
    .bind(accountId, from)
    .first();

  const openingBalance = round2(openingRow ? openingRow.opening : 0);
  const net = round2(credits - debits);

  return {
    account,
    user,
    transactions: results,
    totals: {
      openingBalance,
      credits: round2(credits),
      debits: round2(debits),
      net,
      closingBalance: round2(openingBalance + net),
      currentBalance: account.balance
    }
  };
}

/**
 * POST /api/statements/generate
 * body { accountId, from, to, format? }  format = pdf (default) | csv
 *
 * Renders the statement, stores it in R2 under
 * statements/{userId}/{statementId}.{ext}, and records a row in `statements`.
 */
export async function handleGenerateStatement(request, env, auth) {
  const body = await request.json().catch(() => null);
  const { accountId, from, to } = body || {};
  const format = (body && body.format) || 'pdf';

  if (!accountId || !from || !to) {
    return errorResponse('accountId, from and to are required', 400);
  }
  if (!FORMATS.includes(format)) {
    return errorResponse(`format must be one of: ${FORMATS.join(', ')}`, 400);
  }
  if (from > to) {
    return errorResponse('from must not be after to', 400);
  }

  const data = await collectStatementData(env, auth, accountId, from, to);
  if (data.error) return errorResponse(data.error, data.status);

  const statementId = crypto.randomUUID();
  const bytes = format === 'pdf' ? await renderPdf(data, from, to) : renderCsv(data);
  const r2Key = `statements/${auth.sub}/${statementId}.${format}`;

  await env.BANK_BUCKET.put(r2Key, bytes, {
    httpMetadata: {
      contentType: format === 'pdf' ? 'application/pdf' : 'text/csv'
    }
  });

  const now = new Date().toISOString();
  await env.BANK_DB
    .prepare('INSERT INTO statements (id, user_id, account_id, format, date_range_start, date_range_end, transaction_count, r2_key, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(statementId, auth.sub, accountId, format, from, to, data.transactions.length, r2Key, bytes.length, now)
    .run();

  await recordAudit(
    env,
    request,
    auth.sub,
    'statement_generate',
    `Generated a ${format.toUpperCase()} statement for ${data.account.account_type} covering ${from} to ${to}`
  );

  return jsonResponse({
    message: 'Statement generated',
    statement: {
      id: statementId,
      accountId,
      accountType: data.account.account_type,
      format,
      from,
      to,
      transactionCount: data.transactions.length,
      sizeBytes: bytes.length,
      totals: data.totals,
      createdAt: now
    }
  }, 201);
}

/** GET /api/statements — the caller's generated statements, newest first. */
export async function handleGetStatements(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare(
      `SELECT s.id, s.format, s.date_range_start, s.date_range_end, s.transaction_count,
              s.size_bytes, s.created_at, a.account_type, a.account_number
         FROM statements s
         JOIN accounts a ON a.id = s.account_id
        WHERE s.user_id = ?
        ORDER BY s.created_at DESC`
    )
    .bind(auth.sub)
    .all();

  return jsonResponse({ statements: results });
}

/** GET /api/statements/:id/download — streams the stored file from R2. */
export async function handleDownloadStatement(request, env, auth, statementId) {
  const statement = await env.BANK_DB
    .prepare('SELECT * FROM statements WHERE id = ? AND user_id = ?')
    .bind(statementId, auth.sub)
    .first();
  if (!statement) return errorResponse('Statement not found', 404);

  const object = await env.BANK_BUCKET.get(statement.r2_key);
  if (!object) return errorResponse('Statement file is missing from storage', 404);

  const filename = `statement-${statement.date_range_start}-to-${statement.date_range_end}.${statement.format}`;

  return new Response(object.body, {
    headers: {
      'Content-Type': statement.format === 'pdf' ? 'application/pdf' : 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/** Builds the PDF with pdf-lib. Returns a Uint8Array. */
async function renderPdf(data, from, to) {
  const { account, user, transactions, totals } = data;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28; // A4 portrait, points
  const pageHeight = 841.89;
  const margin = 50;
  const lineHeight = 16;

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const text = (str, opts = {}) => {
    page.drawText(String(str), {
      x: opts.x ?? margin,
      y: opts.y ?? y,
      size: opts.size ?? 9,
      font: opts.bold ? bold : font,
      color: opts.color ?? BLACK
    });
  };

  // Header band, mirroring the app's black nav with a red underline.
  page.drawRectangle({ x: 0, y: pageHeight - 70, width: pageWidth, height: 70, color: BLACK });
  page.drawRectangle({ x: 0, y: pageHeight - 74, width: pageWidth, height: 4, color: BRAND_RED });
  text('PGC BANK', { x: margin, y: pageHeight - 42, size: 18, bold: true, color: rgb(1, 1, 1) });
  text('Account Statement', { x: pageWidth - margin - 110, y: pageHeight - 42, size: 12, color: rgb(1, 1, 1) });

  y = pageHeight - 100;

  text(user ? user.full_name : '', { size: 11, bold: true });
  y -= lineHeight;
  text(`${account.account_type.toUpperCase()} - ${account.account_number}`, { size: 9, color: GRAY });
  y -= lineHeight;
  text(`Period: ${from} to ${to}`, { size: 9, color: GRAY });
  y -= lineHeight;
  text(`Generated: ${new Date().toISOString().slice(0, 10)}`, { size: 9, color: GRAY });

  y -= lineHeight * 2;

  // Summary box
  page.drawRectangle({
    x: margin - 6,
    y: y - 52,
    width: pageWidth - (margin - 6) * 2,
    height: 62,
    color: rgb(0.961, 0.961, 0.961)
  });
  page.drawRectangle({ x: margin - 6, y: y - 52, width: 3, height: 62, color: BRAND_RED });

  const summary = [
    ['Opening Balance', money(totals.openingBalance)],
    ['Total Credits', money(totals.credits)],
    ['Total Debits', money(totals.debits)],
    ['Net Change', money(totals.net)],
    ['Closing Balance', money(totals.closingBalance)]
  ];
  summary.forEach(([label, value], index) => {
    const x = margin + 6 + index * 98;
    text(label, { x, y: y - 4, size: 7.5, color: GRAY });
    text(value, { x, y: y - 20, size: 10.5, bold: true });
  });
  text('Settled transactions only. Opening + net = closing.', { x: margin + 6, y: y - 40, size: 7, color: GRAY });

  y -= 76;

  const columns = [
    { label: 'Date', x: margin, width: 62 },
    { label: 'Description', x: margin + 66, width: 170 },
    { label: 'Category', x: margin + 240, width: 70 },
    { label: 'Type', x: margin + 314, width: 76 },
    { label: 'Status', x: margin + 394, width: 48 },
    { label: 'Amount', x: margin + 446, width: 60 }
  ];

  const drawTableHeader = () => {
    for (const column of columns) {
      text(column.label, { x: column.x, y, size: 8, bold: true, color: GRAY });
    }
    y -= 6;
    page.drawLine({
      start: { x: margin, y },
      end: { x: pageWidth - margin, y },
      thickness: 1.5,
      color: BRAND_RED
    });
    y -= lineHeight;
  };

  drawTableHeader();

  if (transactions.length === 0) {
    text('No transactions in this period.', { size: 9, color: GRAY });
  }

  for (const row of transactions) {
    if (y < margin + 40) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
      drawTableHeader();
    }

    const isCredit = CREDIT_TYPES.includes(row.type);
    const amount = `${isCredit ? '+' : '-'}${money(row.amount)}`;

    text(row.created_at.slice(0, 10), { x: columns[0].x, size: 8 });
    text(truncate(row.merchant || row.description || '-', 30), { x: columns[1].x, size: 8 });
    text(truncate(row.category || '-', 12), { x: columns[2].x, size: 8 });
    text(truncate(row.type.replace(/_/g, ' '), 14), { x: columns[3].x, size: 8 });
    text(row.status, { x: columns[4].x, size: 8, color: row.status === 'completed' ? GRAY : BRAND_RED });
    text(amount, { x: columns[5].x, size: 8, bold: true });

    y -= lineHeight;
  }

  // Footer on every page.
  const pages = pdf.getPages();
  pages.forEach((p, index) => {
    p.drawText(`Page ${index + 1} of ${pages.length}  -  PGC Bank demo statement, not a real financial document`, {
      x: margin,
      y: 28,
      size: 7,
      font,
      color: GRAY
    });
  });

  return await pdf.save();
}

/** Builds the CSV by hand — no library needed. Returns a Uint8Array. */
function renderCsv(data) {
  const { account, transactions, totals } = data;

  const rows = [
    ['PGC Bank Statement'],
    ['Account', `${account.account_type} ${account.account_number}`],
    ['Opening Balance', totals.openingBalance],
    ['Total Credits', totals.credits],
    ['Total Debits', totals.debits],
    ['Net Change', totals.net],
    ['Closing Balance', totals.closingBalance],
    ['Current Balance', totals.currentBalance],
    ['Note', 'Settled transactions only; opening + net = closing'],
    [],
    ['Date', 'Description', 'Merchant', 'Category', 'Type', 'Status', 'Amount', 'Direction']
  ];

  for (const row of transactions) {
    rows.push([
      row.created_at,
      row.description || '',
      row.merchant || '',
      row.category || '',
      row.type,
      row.status,
      row.amount,
      CREDIT_TYPES.includes(row.type) ? 'credit' : 'debit'
    ]);
  }

  const csv = rows.map((cells) => cells.map(csvCell).join(',')).join('\r\n');
  return new TextEncoder().encode(csv);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Quote when the value contains a delimiter, quote or newline; escape quotes
  // by doubling them, per RFC 4180.
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function money(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

function truncate(str, max) {
  const value = String(str);
  return value.length > max ? `${value.slice(0, max - 1)}.` : value;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
