'use strict';

const http = require('node:http');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const SOURCE_URL = process.env.CATALOG_SOURCE_URL || '';
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 5 * 60 * 1000);
const ALLOWED_ORIGINS = new Set(
  String(process.env.CORS_ORIGINS || 'https://cavalrypublishers.co.ke')
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

function sendJson(response, statusCode, data, origin) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(origin ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin'
      } : {})
    });
    response.end();
    return;
  }

  const requestUrl = new URL(request.url, 'http://localhost');
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
      if (!response.headersSent) sendJson(response, 500, { status: 'error', message: 'Internal server error.' });
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

module.exports = { validateCatalogue };
