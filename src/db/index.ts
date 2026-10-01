import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

// Add global connection pool caching to persist across hot-reloads
declare global {
  var _postgresPool: Pool | undefined;
}

export const isDbConfigured = Boolean(process.env.DATABASE_URL || process.env.SQL_HOST);
export const isProduction = process.env.NODE_ENV === 'production';

// Production must run on a real Postgres. In-memory stores are only a degraded-mode safety net
// for a configured database that is failing; an unconfigured production boot is refused outright.
// SYMFLOWAGE_ALLOW_INMEMORY=1 is an explicit, loud escape hatch (demos / smoke tests only).
if (isProduction && !isDbConfigured) {
  if (process.env.SYMFLOWAGE_ALLOW_INMEMORY === '1') {
    console.error('[SECURITY] SYMFLOWAGE_ALLOW_INMEMORY=1: production is running WITHOUT Postgres; data is lost on restart.');
  } else {
    throw new Error(
      'Refusing to start in production without a database: set DATABASE_URL (or SQL_HOST). ' +
        'In-memory fallback is only allowed when a configured database fails at runtime.'
    );
  }
}

let dbFallbackEvents = 0;
let lastDbFallbackAt: number | null = null;
let lastDbFallbackLog = 0;

/** Record that a DB call failed and an in-memory fallback served the request. */
export function reportDbFallback(scope: string, error: unknown) {
  dbFallbackEvents++;
  lastDbFallbackAt = Date.now();
  if (Date.now() - lastDbFallbackLog > 30_000) {
    lastDbFallbackLog = Date.now();
    console.error(`[DB FALLBACK] ${scope}: database call failed, serving from in-memory store:`, (error as Error)?.message || error);
  }
}

export function getDbFallbackStats() {
  return { configured: isDbConfigured, fallbackEvents: dbFallbackEvents, lastFallbackAt: lastDbFallbackAt };
}

// Function to create or retrieve the connection pool.
export const createPool = () => {
  if (!global._postgresPool) {
    if (!isDbConfigured) {
      console.warn('[AI Studio] Database not configured (no DATABASE_URL or SQL_HOST) — using resilient in-memory stores');
    }
    const connectionConfig = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.SQL_HOST || '127.0.0.1',
          user: process.env.SQL_USER || 'mock',
          password: process.env.SQL_PASSWORD || 'mock',
          database: process.env.SQL_DB_NAME || 'mock',
        };
    global._postgresPool = new Pool({
      ...connectionConfig,
      max: 10,
      connectionTimeoutMillis: isDbConfigured ? 10000 : 1000,
    });

    // Prevent unhandled pool-level errors from crashing the application
    global._postgresPool.on('error', (err: Error) => {
      console.warn('Postgres SQL pool notification (safe fallback active):', err?.message || err);
    });
  }
  return global._postgresPool;
};

// Create or retrieve the pool instance.
const pool = createPool();

// Initialize Drizzle with the pool and schema.
export const db = drizzle(pool, { schema });

