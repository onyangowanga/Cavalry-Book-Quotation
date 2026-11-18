'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const SOURCE_URL = process.env.CATALOG_SOURCE_URL || '';
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
}

function hashAdminToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function isValidOrderTrackingToken(token) {
  return /^[a-f0-9]{64}$/.test(String(token || ''));
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
  await pool.query(
    `INSERT INTO public_order_status_cache (token_hash, payload, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (token_hash) DO UPDATE
     SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [tokenHash, JSON.stringify(result)]
  );
  return { ...result, cacheUpdatedAt: new Date().toISOString() };
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
  });
  const syncTimer = setInterval(syncCatalogue, SYNC_INTERVAL_MS);
  syncTimer.unref();

  const shutdown = async signal => {
    console.info(`Received ${signal}; shutting down.`);
    clearInterval(syncTimer);
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
  getBearerToken,
  isValidOrderTrackingToken,
  validateCatalogue
};
