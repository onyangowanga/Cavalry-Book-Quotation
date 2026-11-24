'use strict';

const http = require('node:http');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const SOURCE_URL = process.env.CATALOG_SOURCE_URL || '';
const MPESA_ENVIRONMENT = String(process.env.MPESA_ENVIRONMENT || '').toLowerCase();
const MPESA_SHORTCODE = String(process.env.MPESA_SHORTCODE || '');
const MPESA_TILL_NUMBER = String(process.env.MPESA_TILL_NUMBER || '');
const MPESA_CONSUMER_KEY = String(process.env.MPESA_CONSUMER_KEY || '');
const MPESA_CONSUMER_SECRET = String(process.env.MPESA_CONSUMER_SECRET || '');
const MPESA_PASSKEY = String(process.env.MPESA_PASSKEY || '');
const MPESA_APPS_SCRIPT_SECRET = String(process.env.MPESA_APPS_SCRIPT_SECRET || '');
const MPESA_PUBLIC_BASE_URL = String(process.env.MPESA_PUBLIC_BASE_URL || 'https://api.cavalrypublishers.co.ke').replace(/\/+$/, '');
const MPESA_BASE_URL = MPESA_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 5 * 60 * 1000);
const ADMIN_READ_CACHE_TTL_MS = Number(process.env.ADMIN_READ_CACHE_TTL_MS || 120000);
const PAYMENT_SMS_CACHE_TTL_MS = Number(process.env.PAYMENT_SMS_CACHE_TTL_MS || 15000);
const PUBLIC_ORDER_STATUS_CACHE_TTL_MS = Number(process.env.PUBLIC_ORDER_STATUS_CACHE_TTL_MS || 30000);
const ADMIN_SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ADMIN_READ_ACTIONS = new Set([
  'get_document_data',
  'list_customers',
  'list_documents',
  'list_expenses',
  'list_payment_sms',
  'list_reminders'
]);
const ALLOWED_ORIGINS = new Set(
  String(process.env.CORS_ORIGINS || 'https://cavalrypublishers.co.ke,https://api.cavalrypublishers.co.ke')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.POSTGRES_DB || 'cavalry_books',
  user: process.env.POSTGRES_USER || 'cavalry_app',
  password: process.env.PGPASSWORD,
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

let syncInProgress = false;
const adminReadsInProgress = new Map();
let mpesaAccessToken = '';
let mpesaAccessTokenExpiresAt = 0;

function sendJson(response, statusCode, data, origin) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(origin ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin'
    } : {})
  });
  response.end(JSON.stringify(data));
}

function getAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return '';
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalogue_books (
      book_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalogue_sync_state (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      last_success_at TIMESTAMPTZ,
      last_error TEXT,
      record_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    INSERT INTO catalogue_sync_state (singleton)
    VALUES (TRUE)
    ON CONFLICT (singleton) DO NOTHING
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_api_sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_read_cache (
      cache_key TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_order_status_cache (
      token_hash TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mpesa_payment_links (
      token_hash TEXT PRIMARY KEY,
      invoice_reference TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS mpesa_payment_links_invoice_idx
    ON mpesa_payment_links (invoice_reference, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mpesa_stk_requests (
      id UUID PRIMARY KEY,
      token_hash TEXT NOT NULL REFERENCES mpesa_payment_links(token_hash),
      invoice_reference TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      phone TEXT NOT NULL,
      merchant_request_id TEXT,
      checkout_request_id TEXT UNIQUE,
      status TEXT NOT NULL,
      callback_result_code INTEGER,
      callback_result_desc TEXT,
      callback_amount NUMERIC(12, 2),
      callback_receipt TEXT,
      callback_phone TEXT,
      receipt_reference TEXT,
      receipt_data JSONB,
      tracking_url TEXT,
      verification_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE mpesa_stk_requests
    ADD COLUMN IF NOT EXISTS receipt_reference TEXT
  `);
  await pool.query(`
    ALTER TABLE mpesa_stk_requests
    ADD COLUMN IF NOT EXISTS receipt_data JSONB
  `);
  await pool.query(`
    ALTER TABLE mpesa_stk_requests
    ADD COLUMN IF NOT EXISTS tracking_url TEXT
  `);
  await pool.query(`
    ALTER TABLE mpesa_stk_requests
    ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS mpesa_stk_requests_pending_idx
    ON mpesa_stk_requests (status, updated_at)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mpesa_one_active_stk_per_invoice_idx
    ON mpesa_stk_requests (invoice_reference)
    WHERE status IN ('INITIATING', 'INITIATION_UNKNOWN', 'PENDING', 'CALLBACK_RECEIVED', 'PROCESSING')
  `);
}

function hashAdminToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function isValidOrderTrackingToken(token) {
  return /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(String(token || ''));
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error('Request body exceeds the allowed size.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new Error('Request body must contain valid JSON.');
  }
}

function getBearerToken(request) {
  const match = /^Bearer (SESSION-[A-Za-z0-9-]+)$/.exec(String(request.headers.authorization || ''));
  return match ? match[1] : '';
}

async function getAdminSession(request) {
  const token = getBearerToken(request);
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT username FROM admin_api_sessions
     WHERE token_hash = $1 AND expires_at > NOW()`,
    [hashAdminToken(token)]
  );
  return rows[0] ? { token, username: rows[0].username } : null;
}

async function callAppsScript(payload) {
  if (!SOURCE_URL) throw new Error('CATALOG_SOURCE_URL is not configured.');
  const response = await fetch(SOURCE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`Apps Script returned HTTP ${response.status}.`);
  const result = await response.json();
  if (!result || typeof result !== 'object') throw new Error('Apps Script returned an invalid response.');
  return result;
}

function adminReadCacheKey(action, payload) {
  if (!ADMIN_READ_ACTIONS.has(action)) throw new Error('This admin read action is not supported by the VPS API.');
  if (action === 'get_document_data') {
    const reference = String(payload.reference || '').trim();
    if (!reference || reference.length > 100) throw new Error('A valid document reference is required.');
    return `${action}:${reference}`;
  }
  return action;
}

async function getAdminRead(cacheKey, action, payload, session, forceRefresh) {
  const cacheTtlMs = action === 'list_payment_sms' ? PAYMENT_SMS_CACHE_TTL_MS
    : action === 'list_reminders' ? Math.min(ADMIN_READ_CACHE_TTL_MS, 30000)
      : ADMIN_READ_CACHE_TTL_MS;
  if (!forceRefresh) {
    const { rows } = await pool.query(
      `SELECT payload, updated_at
       FROM admin_read_cache
       WHERE cache_key = $1 AND updated_at > NOW() - ($2::double precision * INTERVAL '1 millisecond')`,
      [cacheKey, cacheTtlMs]
    );
    if (rows[0]) {
      return {
        ...rows[0].payload,
        cacheSource: 'postgresql-cache',
        cacheUpdatedAt: rows[0].updated_at
      };
    }
  }

  const activeRequest = adminReadsInProgress.get(cacheKey);
  if (activeRequest) {
    await activeRequest;
    if (!forceRefresh) return activeRequest;
  }

  const readRequest = (async () => {
    const appsScriptPayload = { ...payload };
    delete appsScriptPayload.forceRefresh;
    const result = await callAppsScript({
      ...appsScriptPayload,
      action,
      staffPassword: session.token
    });
    if (result.status !== 'success') {
      const error = new Error(result.message || 'The admin data request was not authorized.');
      error.statusCode = result.message === 'Staff authorization required.' ? 401 : 502;
      throw error;
    }
    await pool.query(
      `INSERT INTO admin_read_cache (cache_key, action, payload, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (cache_key) DO UPDATE
       SET action = EXCLUDED.action, payload = EXCLUDED.payload, updated_at = NOW()`,
      [cacheKey, action, JSON.stringify(result)]
    );
    return {
      ...result,
      cacheSource: 'apps-script',
      cacheUpdatedAt: new Date().toISOString()
    };
  })().finally(() => adminReadsInProgress.delete(cacheKey));

  adminReadsInProgress.set(cacheKey, readRequest);
  return readRequest;
}

async function getPublicOrderStatus(token, forceRefresh = false) {
  const tokenHash = hashAdminToken(token);
  if (!forceRefresh) {
    const { rows } = await pool.query(
      `SELECT payload, updated_at
       FROM public_order_status_cache
       WHERE token_hash = $1
         AND updated_at > NOW() - ($2::double precision * INTERVAL '1 millisecond')`,
      [tokenHash, PUBLIC_ORDER_STATUS_CACHE_TTL_MS]
    );
    if (rows[0]) {
      return {
        ...rows[0].payload,
        cacheUpdatedAt: rows[0].updated_at
      };
    }
  }

  const result = await callAppsScript({
    action: 'get_public_order_status',
    trackingToken: token
  });
  if (result.status !== 'success') {
    const error = new Error(result.message || 'This order could not be found.');
    error.statusCode = result.message === 'This order could not be found.' ? 404 : 502;
    throw error;
  }
  const invoiceReference = String(result.data && result.data.invoiceReference || '').trim();
  if (invoiceReference && Number(result.data.balance) > 0) {
    await pool.query(
      `INSERT INTO mpesa_payment_links (token_hash, invoice_reference, created_by)
       VALUES ($1, $2, 'public-order-tracking')
       ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash, invoiceReference]
    );
    const { rows } = await pool.query(
      `SELECT invoice_reference
       FROM mpesa_payment_links
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash]
    );
    if (rows[0] && rows[0].invoice_reference === invoiceReference) {
      result.data.paymentUrl = buildPaymentLinkUrl(MPESA_PUBLIC_BASE_URL, token);
    }
  }
  await pool.query(
    `INSERT INTO public_order_status_cache (token_hash, payload, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (token_hash) DO UPDATE
     SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [tokenHash, JSON.stringify(result)]
  );
  return { ...result, cacheUpdatedAt: new Date().toISOString() };
}

function paymentError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isValidPaymentLinkToken(token) {
  return /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(String(token || ''));
}

function normalizeKenyanPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `254${digits.slice(1)}`;
  if (digits.length === 9 && /^[17]/.test(digits)) digits = `254${digits}`;
  return /^254[17]\d{8}$/.test(digits) ? digits : '';
}

function getMpesaTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

function getMpesaPassword(businessShortCode, passkey, timestamp) {
  return Buffer.from(`${businessShortCode}${passkey}${timestamp}`).toString('base64');
}

function buildMpesaStkPayload({ businessShortCode, tillNumber, passkey, callbackUrl, phone, amount, requestId, timestamp }) {
  return {
    BusinessShortCode: businessShortCode,
    Password: getMpesaPassword(businessShortCode, passkey, timestamp),
    Timestamp: timestamp,
    TransactionType: 'CustomerBuyGoodsOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: tillNumber,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: `CP${requestId.replace(/-/g, '').slice(0, 10)}`,
    TransactionDesc: 'Invoice payment'
  };
}

function getMpesaConfig() {
  if (!['production', 'sandbox'].includes(MPESA_ENVIRONMENT) ||
      !/^\d{5,10}$/.test(MPESA_SHORTCODE) ||
      !/^\d{5,10}$/.test(MPESA_TILL_NUMBER) ||
      !MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_PASSKEY ||
      !MPESA_APPS_SCRIPT_SECRET || !/^https:\/\//i.test(MPESA_PUBLIC_BASE_URL)) {
    throw paymentError('M-Pesa payments are not fully configured on the server.', 503);
  }
  return {
    businessShortCode: MPESA_SHORTCODE,
    tillNumber: MPESA_TILL_NUMBER,
    callbackUrl: `${MPESA_PUBLIC_BASE_URL}/api/v1/mpesa/callback`
  };
}

async function getMpesaAccessToken() {
  if (mpesaAccessToken && Date.now() < mpesaAccessTokenExpiresAt) return mpesaAccessToken;
  const credentials = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const response = await fetch(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(15000)
    }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) {
    throw paymentError('Could not authenticate with Safaricom. Check the server-side Daraja credentials.', 502);
  }
  mpesaAccessToken = String(result.access_token);
  mpesaAccessTokenExpiresAt = Date.now() + Math.max(60, Number(result.expires_in || 3600) - 60) * 1000;
  return mpesaAccessToken;
}

async function callMpesaApi(path, payload) {
  const accessToken = await getMpesaAccessToken();
  const response = await fetch(`${MPESA_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw paymentError(`Safaricom payment service returned HTTP ${response.status}.`, 502);
  }
  return result;
}

async function getInvoiceSnapshot(reference, staffPassword = '') {
  const result = await callAppsScript({
    action: 'get_document_data',
    reference,
    ...(staffPassword ? { staffPassword } : {})
  });
  if (result.status !== 'success' || !result.data || result.data.type !== 'invoice') {
    throw paymentError(result.message || 'Invoice not found.', 404);
  }
  const invoice = result.data;
  const balance = Number(invoice.balance ?? invoice.total);
  if (!Number.isFinite(balance) || balance < 0) {
    throw paymentError('The invoice balance is invalid. Contact Cavalry Publishers.', 502);
  }
  if (['ARCHIVED', 'VOID'].includes(String(invoice.status || '').toUpperCase())) {
    throw paymentError('This invoice is no longer available for payment.', 410);
  }
  return { ...invoice, balance };
}

async function getPaymentLink(token) {
  if (!isValidPaymentLinkToken(token)) throw paymentError('This payment link is invalid.', 400);
  const tokenHash = hashAdminToken(token);
  const { rows } = await pool.query(
    `SELECT token_hash, invoice_reference
     FROM mpesa_payment_links
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
  if (!rows[0]) throw paymentError('This payment link is invalid or has expired.', 404);
  return rows[0];
}

function buildPaymentLinkUrl(baseUrl, token) {
  return `${baseUrl}/admin/payment.html#${token}`;
}

async function createPaymentLink(invoiceReference, session) {
  getMpesaConfig();
  const reference = String(invoiceReference || '').trim();
  if (!reference || reference.length > 100) throw paymentError('A valid invoice reference is required.');
  const invoice = await getInvoiceSnapshot(reference, session.token);
  if (invoice.balance <= 0) throw paymentError('This invoice has no remaining balance.', 409);
  if (Math.abs(invoice.balance - Math.round(invoice.balance)) > 0.005) {
    throw paymentError('This invoice has a fractional balance and cannot be paid by M-Pesa STK. Adjust the invoice first.', 409);
  }
  const token = randomBytes(16).toString('hex');
  const tokenHash = hashAdminToken(token);
  await pool.query(
    `INSERT INTO mpesa_payment_links (token_hash, invoice_reference, created_by)
     VALUES ($1, $2, $3)`,
    [tokenHash, reference, session.username]
  );
  return {
    url: buildPaymentLinkUrl(MPESA_PUBLIC_BASE_URL, token),
    invoiceReference: reference,
    balance: invoice.balance
  };
}

async function getCheckoutDetails(token) {
  const link = await getPaymentLink(token);
  const invoice = await getInvoiceSnapshot(link.invoice_reference);
  const { rows } = await pool.query(
    `SELECT checkout_request_id, amount, callback_receipt, receipt_reference,
            receipt_data, tracking_url, updated_at
     FROM mpesa_stk_requests
     WHERE token_hash = $1 AND status = 'COMPLETED'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [link.token_hash]
  );
  let receiptData = rows[0] && rows[0].receipt_data;
  if (rows[0] && !receiptData && rows[0].receipt_reference) {
    const receiptResult = await callAppsScript({
      action: 'get_document_data',
      reference: rows[0].receipt_reference
    });
    if (receiptResult.status !== 'success' || !receiptResult.data || receiptResult.data.type !== 'receipt') {
      throw paymentError('The system-generated receipt is temporarily unavailable. Please reload shortly.', 502);
    }
    receiptData = receiptResult.data;
    await pool.query(
      `UPDATE mpesa_stk_requests
       SET receipt_data = $2::jsonb
       WHERE checkout_request_id = $1 AND receipt_data IS NULL`,
      [rows[0].checkout_request_id, JSON.stringify(receiptData)]
    );
  }
  const latestPayment = rows[0] ? {
    status: 'COMPLETED',
    paymentId: rows[0].checkout_request_id,
    amount: Number(rows[0].amount),
    receipt: rows[0].callback_receipt,
    receiptReference: rows[0].receipt_reference,
    receiptData,
    trackingUrl: rows[0].tracking_url,
    paidAt: rows[0].updated_at,
    balance: invoice.balance
  } : null;
  return {
    invoiceReference: invoice.reference,
    clientName: invoice.clientName || 'Valued Client',
    balance: invoice.balance,
    status: invoice.status,
    latestPayment
  };
}

async function initiateMpesaPayment(token, phoneValue) {
  const config = getMpesaConfig();
  const link = await getPaymentLink(token);
  const phone = normalizeKenyanPhone(phoneValue);
  if (!phone) throw paymentError('Enter a valid Kenyan M-Pesa number, such as 0712345678.');
  const invoice = await getInvoiceSnapshot(link.invoice_reference);
  const balance = invoice.balance;
  if (balance <= 0) throw paymentError('This invoice is already fully paid.', 409);
  if (Math.abs(balance - Math.round(balance)) > 0.005) {
    throw paymentError('This invoice has a fractional balance and cannot be paid by M-Pesa STK. Please contact Cavalry Publishers.', 409);
  }
  const amount = Math.round(balance);
  if (amount < 1) throw paymentError('The remaining balance is below the minimum M-Pesa amount.', 409);
  await getMpesaAccessToken();

  const id = randomUUID();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [link.invoice_reference]);
    await client.query(
      `UPDATE mpesa_stk_requests
       SET status = 'EXPIRED', updated_at = NOW()
       WHERE invoice_reference = $1
         AND status IN ('INITIATING', 'INITIATION_UNKNOWN', 'PENDING')
         AND updated_at <= NOW() - INTERVAL '5 minutes'`,
      [link.invoice_reference]
    );
    const active = await client.query(
      `SELECT id, status
       FROM mpesa_stk_requests
       WHERE invoice_reference = $1
         AND status IN ('INITIATING', 'INITIATION_UNKNOWN', 'PENDING', 'CALLBACK_RECEIVED', 'PROCESSING')
       LIMIT 1`,
      [link.invoice_reference]
    );
    if (active.rows[0]) throw paymentError('An M-Pesa payment request is already in progress for this invoice. Wait for it to finish before trying again.', 409);
    await client.query(
      `INSERT INTO mpesa_stk_requests
       (id, token_hash, invoice_reference, amount, phone, status)
       VALUES ($1, $2, $3, $4, $5, 'INITIATING')`,
      [id, link.token_hash, link.invoice_reference, amount, phone]
    );
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw paymentError('An M-Pesa payment request is already in progress for this invoice. Wait for it to finish before trying again.', 409);
    throw error;
  } finally {
    if (client) client.release();
  }

  const timestamp = getMpesaTimestamp();
  const payload = buildMpesaStkPayload({
    businessShortCode: config.businessShortCode,
    tillNumber: config.tillNumber,
    passkey: MPESA_PASSKEY,
    callbackUrl: config.callbackUrl,
    phone,
    amount,
    requestId: id,
    timestamp
  });

  try {
    const result = await callMpesaApi('/mpesa/stkpush/v1/processrequest', payload);
    if (String(result.ResponseCode || '') !== '0' || !result.CheckoutRequestID) {
      await pool.query(
        `UPDATE mpesa_stk_requests
         SET status = 'FAILED', callback_result_desc = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, String(result.ResponseDescription || result.errorMessage || 'Safaricom did not accept the payment request.').slice(0, 500)]
      );
      throw paymentError(result.ResponseDescription || result.errorMessage || 'Safaricom did not accept the payment request.', 502);
    }
    await pool.query(
      `UPDATE mpesa_stk_requests
       SET merchant_request_id = $2, checkout_request_id = $3, status = 'PENDING', updated_at = NOW()
       WHERE id = $1`,
      [id, String(result.MerchantRequestID || ''), String(result.CheckoutRequestID)]
    );
    return {
      paymentId: String(result.CheckoutRequestID),
      amount,
      message: String(result.CustomerMessage || 'Check your phone for the M-Pesa prompt.')
    };
  } catch (error) {
    await pool.query(
      `UPDATE mpesa_stk_requests
       SET status = 'INITIATION_UNKNOWN', callback_result_desc = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'INITIATING'`,
      [id, String(error.message || 'Payment request status is unknown.').slice(0, 500)]
    );
    throw error;
  }
}

function getCallbackMetadata(callback) {
  const metadata = {};
  const items = callback && callback.CallbackMetadata && callback.CallbackMetadata.Item;
  if (!Array.isArray(items)) return metadata;
  for (const item of items) {
    if (item && item.Name) metadata[item.Name] = item.Value;
  }
  return metadata;
}

async function queryMpesaPayment(checkoutRequestId) {
  const { businessShortCode } = getMpesaConfig();
  const timestamp = getMpesaTimestamp();
  return callMpesaApi('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: businessShortCode,
    Password: getMpesaPassword(businessShortCode, MPESA_PASSKEY, timestamp),
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId
  });
}

async function processMpesaCallback(checkoutRequestId) {
  const claim = await pool.query(
    `UPDATE mpesa_stk_requests
     SET status = 'PROCESSING', updated_at = NOW()
     WHERE checkout_request_id = $1
       AND status = 'CALLBACK_RECEIVED'
     RETURNING *`,
    [checkoutRequestId]
  );
  const attempt = claim.rows[0];
  if (!attempt) return;
  try {
    if (Number(attempt.callback_result_code) !== 0) {
      await pool.query(
        `UPDATE mpesa_stk_requests SET status = 'FAILED', updated_at = NOW() WHERE id = $1`,
        [attempt.id]
      );
      return;
    }
    const callbackAmount = Number(attempt.callback_amount);
    const callbackPhone = normalizeKenyanPhone(attempt.callback_phone);
    if (callbackAmount !== Number(attempt.amount) ||
        callbackPhone !== attempt.phone ||
        !/^[A-Z0-9]{8,12}$/.test(String(attempt.callback_receipt || ''))) {
      await pool.query(
        `UPDATE mpesa_stk_requests
         SET status = 'REVIEW_REQUIRED', updated_at = NOW()
         WHERE id = $1`,
        [attempt.id]
      );
      return;
    }

    const verification = await queryMpesaPayment(checkoutRequestId);
    if (Number(verification.ResultCode) !== 0) {
      const tries = Number(attempt.verification_attempts || 0) + 1;
      await pool.query(
        `UPDATE mpesa_stk_requests
         SET status = $2, verification_attempts = $3,
             callback_result_desc = $4, updated_at = NOW()
         WHERE id = $1`,
        [
          attempt.id,
          tries >= 10 ? 'REVIEW_REQUIRED' : 'CALLBACK_RECEIVED',
          tries,
          String(verification.ResultDesc || 'Safaricom has not confirmed the payment yet.').slice(0, 500)
        ]
      );
      return;
    }

    const result = await callAppsScript({
      action: 'record_verified_mpesa_payment',
      serverSecret: MPESA_APPS_SCRIPT_SECRET,
      invoiceReference: attempt.invoice_reference,
      paymentAmount: Number(attempt.amount),
      paymentRequestId: `MPESA-${checkoutRequestId}`,
      paymentReference: attempt.callback_receipt
    });
    if (result.status !== 'success') {
      const requiresReview = /fully paid|cannot exceed|not found|invalid/i.test(String(result.message || ''));
      await pool.query(
        `UPDATE mpesa_stk_requests
         SET status = $2, callback_result_desc = $3, updated_at = NOW()
         WHERE id = $1`,
        [attempt.id, requiresReview ? 'REVIEW_REQUIRED' : 'CALLBACK_RECEIVED', String(result.message || 'Payment could not be recorded.').slice(0, 500)]
      );
      return;
    }
    if (!result.data || result.data.type !== 'receipt' || result.data.reference !== result.reference) {
      throw new Error('Apps Script did not return the generated receipt document.');
    }
    await pool.query(
      `UPDATE mpesa_stk_requests
       SET status = 'COMPLETED', callback_result_desc = 'Payment confirmed',
           receipt_reference = $2, receipt_data = $3::jsonb, tracking_url = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [attempt.id, String(result.reference || ''), JSON.stringify(result.data), String(result.trackingUrl || '')]
    );
    await pool.query('DELETE FROM admin_read_cache');
    await pool.query('DELETE FROM public_order_status_cache');
  } catch (error) {
    await pool.query(
      `UPDATE mpesa_stk_requests
       SET status = 'CALLBACK_RECEIVED', callback_result_desc = $2,
           verification_attempts = verification_attempts + 1, updated_at = NOW()
       WHERE id = $1`,
      [attempt.id, String(error.message || 'Payment verification could not be completed.').slice(0, 500)]
    );
    console.error('M-Pesa callback processing failed:', error.message);
  }
}

async function processPendingMpesaCallbacks() {
  await pool.query(
    `UPDATE mpesa_stk_requests
     SET status = 'CALLBACK_RECEIVED', updated_at = NOW()
     WHERE status = 'PROCESSING'
       AND updated_at <= NOW() - INTERVAL '2 minutes'`
  );
  const { rows } = await pool.query(
    `SELECT checkout_request_id
     FROM mpesa_stk_requests
     WHERE status = 'CALLBACK_RECEIVED'
     ORDER BY updated_at
     LIMIT 20`
  );
  for (const row of rows) {
    await processMpesaCallback(row.checkout_request_id);
  }
}

function validateCatalogue(data) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('The catalogue source returned no books; the cached catalogue was left unchanged.');
  }
  const seenIds = new Set();
  return data.map(book => {
    const id = Number(book && book.id);
    const title = String(book && book.title || '').trim();
    const unitCost = Number(book && book.unitCost);
    if (!Number.isSafeInteger(id) || id < 0 || !title || !Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error('The catalogue source returned a book with invalid required fields.');
    }
    if (seenIds.has(id)) throw new Error('The catalogue source returned duplicate book IDs.');
    seenIds.add(id);
    return { id, title, data: book };
  });
}

async function recordSyncError(message) {
  await pool.query(
    'UPDATE catalogue_sync_state SET last_error = $1 WHERE singleton = TRUE',
    [String(message).slice(0, 500)]
  );
}

async function syncCatalogue() {
  if (syncInProgress) return;
  if (!SOURCE_URL) throw new Error('CATALOG_SOURCE_URL is not configured.');
  syncInProgress = true;
  let client;
  try {
    const sourceResponse = await fetch(SOURCE_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow'
    });
    if (!sourceResponse.ok) throw new Error(`Catalogue source returned HTTP ${sourceResponse.status}.`);
    const sourceData = await sourceResponse.json();
    if (sourceData.status !== 'success') {
      throw new Error('Catalogue source returned an unsuccessful response.');
    }
    const books = validateCatalogue(sourceData.data);

    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM catalogue_books');
    for (const book of books) {
      await client.query(
        `INSERT INTO catalogue_books (book_id, title, data, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())`,
        [book.id, book.title, JSON.stringify(book.data)]
      );
    }
    await client.query(
      `UPDATE catalogue_sync_state
       SET last_success_at = NOW(), last_error = NULL, record_count = $1
       WHERE singleton = TRUE`,
      [books.length]
    );
    await client.query('COMMIT');
    console.info(`Catalogue synchronized: ${books.length} books.`);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(rollbackError => {
      console.error('Catalogue rollback failed:', rollbackError.message);
    });
    try {
      await recordSyncError(error.message);
    } catch (stateError) {
      console.error('Could not record catalogue sync failure:', stateError.message);
    }
    console.error('Catalogue sync failed; retaining cached data:', error.message);
  } finally {
    if (client) client.release();
    syncInProgress = false;
  }
}

async function handleRequest(request, response) {
  const origin = getAllowedOrigin(request);
  if (origin === null) {
    sendJson(response, 403, { status: 'error', message: 'Origin is not allowed.' });
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      ...(origin ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        Vary: 'Origin'
      } : {})
    });
    response.end();
    return;
  }

  const requestUrl = new URL(request.url, 'http://localhost');
  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/admin/mpesa/payment-link') {
    const session = await getAdminSession(request);
    if (!session) {
      sendJson(response, 401, { status: 'error', message: 'Staff session expired. Log in again.' }, origin);
      return;
    }
    try {
      const body = await readJsonBody(request);
      const data = await createPaymentLink(body.invoiceReference, session);
      sendJson(response, 200, { status: 'success', data }, origin);
    } catch (error) {
      const statusCode = error.statusCode || 503;
      if (statusCode >= 500) console.error('M-Pesa payment link creation failed:', error.message);
      sendJson(response, statusCode, { status: 'error', message: error.message }, origin);
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/mpesa/checkout') {
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, { status: 'success', data: await getCheckoutDetails(String(body.token || '')) }, origin);
    } catch (error) {
      sendJson(response, error.statusCode || 503, { status: 'error', message: error.message }, origin);
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/mpesa/initiate') {
    try {
      const body = await readJsonBody(request);
      const data = await initiateMpesaPayment(String(body.token || ''), body.phone);
      sendJson(response, 202, { status: 'success', data }, origin);
    } catch (error) {
      const statusCode = error.statusCode || 503;
      if (statusCode >= 500) console.error('M-Pesa STK initiation failed:', error.message);
      sendJson(response, statusCode, { status: 'error', message: error.message }, origin);
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/mpesa/status') {
    try {
      const body = await readJsonBody(request);
      const link = await getPaymentLink(String(body.token || ''));
      const paymentId = String(body.paymentId || '');
      const { rows } = await pool.query(
        `SELECT status, callback_result_desc, callback_receipt, amount,
                receipt_reference, receipt_data, tracking_url, updated_at
         FROM mpesa_stk_requests
         WHERE checkout_request_id = $1 AND token_hash = $2`,
        [paymentId, link.token_hash]
      );
      if (!rows[0]) throw paymentError('The payment request could not be found.', 404);
      const data = { status: rows[0].status, message: rows[0].callback_result_desc || '' };
      if (rows[0].status === 'COMPLETED') {
        data.receipt = rows[0].callback_receipt;
        data.amount = Number(rows[0].amount);
        data.receiptReference = rows[0].receipt_reference;
        data.receiptData = rows[0].receipt_data;
        data.trackingUrl = rows[0].tracking_url;
        data.paidAt = rows[0].updated_at;
        const invoice = await getInvoiceSnapshot(link.invoice_reference);
        data.balance = invoice.balance;
        data.invoiceReference = invoice.reference;
        data.clientName = invoice.clientName || 'Valued Client';
        data.invoiceStatus = invoice.status;
      }
      sendJson(response, 200, { status: 'success', data }, origin);
    } catch (error) {
      sendJson(response, error.statusCode || 503, { status: 'error', message: error.message }, origin);
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/mpesa/callback') {
    const body = await readJsonBody(request);
    const callback = body && body.Body && body.Body.stkCallback;
    const checkoutRequestId = String(callback && callback.CheckoutRequestID || '');
    const callbackResultCode = Number(callback && callback.ResultCode);
    if (callback && checkoutRequestId && Number.isInteger(callbackResultCode)) {
      const metadata = getCallbackMetadata(callback);
      await pool.query(
        `UPDATE mpesa_stk_requests
         SET status = CASE WHEN $2 = 0 THEN 'CALLBACK_RECEIVED' ELSE 'FAILED' END,
             callback_result_code = $2,
             callback_result_desc = $3,
             callback_amount = $4,
             callback_receipt = $5,
             callback_phone = $6,
             updated_at = NOW()
         WHERE checkout_request_id = $1
           AND status NOT IN ('COMPLETED', 'REVIEW_REQUIRED', 'PROCESSING')`,
        [
          checkoutRequestId,
          callbackResultCode,
          String(callback.ResultDesc || '').slice(0, 500),
          metadata.Amount === undefined ? null : Number(metadata.Amount),
          String(metadata.MpesaReceiptNumber || '').toUpperCase(),
          String(metadata.PhoneNumber || '')
        ]
      );
      setImmediate(() => processMpesaCallback(checkoutRequestId).catch(error => {
        console.error('M-Pesa callback scheduling failed:', error.message);
      }));
    }
    sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Accepted' }, origin);
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/order-status') {
    const body = await readJsonBody(request);
    const token = String(body.token || '');
    if (!isValidOrderTrackingToken(token)) {
      sendJson(response, 400, { status: 'error', message: 'This order link is invalid.' }, origin);
      return;
    }
    try {
      sendJson(response, 200, await getPublicOrderStatus(token, body.forceRefresh === true), origin);
    } catch (error) {
      const statusCode = error.statusCode || 503;
      if (statusCode >= 500) console.error('Public order status lookup failed:', error.message);
      const message = statusCode >= 500 ? 'Order details are temporarily unavailable. Please try again.'
        : statusCode === 404 ? 'This order could not be found.' : error.message;
      sendJson(response, statusCode, { status: 'error', message }, origin);
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/admin/session') {
    const body = await readJsonBody(request);
    const token = String(body.staffPassword || '');
    if (!token.startsWith('SESSION-') || token.length > 200) {
      sendJson(response, 401, { status: 'error', message: 'A valid staff session is required.' }, origin);
      return;
    }
    try {
      const result = await callAppsScript({ action: 'restore_session', staffPassword: token });
      if (result.status !== 'success' || !result.username) {
        sendJson(response, 401, { status: 'error', message: 'Staff session has expired. Log in again.' }, origin);
        return;
      }
      const requestedExpiry = Number(body.expiresAt);
      if (!Number.isFinite(requestedExpiry) || requestedExpiry <= Date.now()) {
        sendJson(response, 401, { status: 'error', message: 'Staff session expiry is invalid. Log in again.' }, origin);
        return;
      }
      const sessionExpiresAt = Math.min(
        requestedExpiry,
        Date.now() + ADMIN_SESSION_MAX_AGE_MS
      );
      await pool.query(
        `INSERT INTO admin_api_sessions (token_hash, username, expires_at)
         VALUES ($1, $2, TO_TIMESTAMP($3::double precision / 1000.0))
         ON CONFLICT (token_hash) DO UPDATE
         SET username = EXCLUDED.username, expires_at = EXCLUDED.expires_at`,
        [hashAdminToken(token), result.username, sessionExpiresAt]
      );
      await pool.query('DELETE FROM admin_api_sessions WHERE expires_at <= NOW()');
      sendJson(response, 200, { status: 'success', username: result.username, expiresAt: sessionExpiresAt }, origin);
    } catch (error) {
      console.error('Admin session registration failed:', error.message);
      sendJson(response, 503, { status: 'error', message: 'Admin read service could not validate the staff session.' }, origin);
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/admin/read') {
    const session = await getAdminSession(request);
    if (!session) {
      sendJson(response, 401, { status: 'error', message: 'Staff session expired. Log in again.' }, origin);
      return;
    }
    const body = await readJsonBody(request);
    const action = String(body.action || '');
    try {
      const cacheKey = adminReadCacheKey(action, body);
      const result = await getAdminRead(cacheKey, action, body, session, body.forceRefresh === true);
      sendJson(response, 200, result, origin);
    } catch (error) {
      const status = error.message.includes('not supported') || error.message.includes('reference is required') ? 400 : error.statusCode || 503;
      console.error(`Admin read failed (${action}):`, error.message);
      sendJson(response, status, { status: 'error', message: error.message }, origin);
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/admin/invalidate') {
    if (!await getAdminSession(request)) {
      sendJson(response, 401, { status: 'error', message: 'Staff session expired. Log in again.' }, origin);
      return;
    }
    try {
      const options = Number(request.headers['content-length'] || 0) > 0 || request.headers['transfer-encoding']
        ? await readJsonBody(request)
        : {};
      await pool.query('DELETE FROM admin_read_cache');
      await pool.query('DELETE FROM public_order_status_cache');
      if (options.refreshCatalogue === true) {
        await syncCatalogue();
        const { rows } = await pool.query(
          'SELECT last_error FROM catalogue_sync_state WHERE singleton = TRUE'
        );
        if (rows[0] && rows[0].last_error) {
          sendJson(response, 503, { status: 'error', message: 'Catalogue changed, but the VPS catalogue cache could not be refreshed.' }, origin);
          return;
        }
      }
      sendJson(response, 200, { status: 'success' }, origin);
    } catch (error) {
      console.error('Admin read cache invalidation failed:', error.message);
      sendJson(response, 503, { status: 'error', message: 'Admin data cache could not be refreshed.' }, origin);
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/v1/admin/logout') {
    const session = await getAdminSession(request);
    if (session) {
      await pool.query('DELETE FROM admin_api_sessions WHERE token_hash = $1', [hashAdminToken(session.token)]);
    }
    sendJson(response, 200, { status: 'success' }, origin);
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
    try {
      const { rows } = await pool.query(`
        SELECT sync.last_success_at, sync.record_count,
          (SELECT COUNT(*)::INTEGER FROM catalogue_books) AS cached_count
        FROM catalogue_sync_state AS sync
        WHERE singleton = TRUE
      `);
      sendJson(response, 200, {
        status: 'success',
        database: 'connected',
        cachedBooks: rows[0] ? rows[0].cached_count : 0,
        lastCatalogueSync: rows[0] ? rows[0].last_success_at : null
      }, origin);
    } catch (error) {
      console.error('Health check failed:', error.message);
      sendJson(response, 503, { status: 'error', database: 'unavailable' }, origin);
    }
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/v1/catalog') {
    try {
      const { rows } = await pool.query(`
        SELECT book.data, sync.last_success_at
        FROM catalogue_books AS book
        CROSS JOIN catalogue_sync_state AS sync
        WHERE sync.singleton = TRUE
        ORDER BY book.book_id
      `);
      if (!rows.length) {
        sendJson(response, 503, {
          status: 'error',
          message: 'Catalogue cache is empty and the source is currently unavailable.'
        }, origin);
        return;
      }
      sendJson(response, 200, {
        status: 'success',
        data: rows.map(row => row.data),
        source: 'postgresql-cache',
        lastUpdated: rows[0].last_success_at
      }, origin);
    } catch (error) {
      console.error('Catalogue query failed:', error.message);
      sendJson(response, 503, { status: 'error', message: 'Catalogue cache is unavailable.' }, origin);
    }
    return;
  }

  sendJson(response, 404, { status: 'error', message: 'Route not found.' }, origin);
}

async function start() {
  await ensureSchema();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      console.error('Unhandled API request error:', error.message);
      if (!response.headersSent) {
        const statusCode = error.message.includes('Request body') ? 400 : 500;
        sendJson(response, statusCode, { status: 'error', message: error.message.includes('Request body') ? error.message : 'Internal server error.' }, getAllowedOrigin(request) || '');
      }
      else response.destroy();
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.info(`Cavalry Books API listening on port ${PORT}.`);
    syncCatalogue();
    processPendingMpesaCallbacks().catch(error => {
      console.error('M-Pesa callback recovery failed:', error.message);
    });
  });
  const syncTimer = setInterval(syncCatalogue, SYNC_INTERVAL_MS);
  syncTimer.unref();
  const mpesaRecoveryTimer = setInterval(() => {
    processPendingMpesaCallbacks().catch(error => {
      console.error('M-Pesa callback recovery failed:', error.message);
    });
  }, 30000);
  mpesaRecoveryTimer.unref();

  const shutdown = async signal => {
    console.info(`Received ${signal}; shutting down.`);
    clearInterval(syncTimer);
    clearInterval(mpesaRecoveryTimer);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch(error => {
    console.error('API startup failed:', error);
    process.exit(1);
  });
}

module.exports = {
  adminReadCacheKey,
  buildPaymentLinkUrl,
  buildMpesaStkPayload,
  getCallbackMetadata,
  getBearerToken,
  getMpesaPassword,
  getMpesaTimestamp,
  isValidOrderTrackingToken,
  isValidPaymentLinkToken,
  normalizeKenyanPhone,
  validateCatalogue
};
