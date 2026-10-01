import { db } from '../db/index.ts';
import { sql } from 'drizzle-orm';

// Mirrors drizzle/0002_tenants_api_keys.sql (idempotent). Applied once at startup when a DB is configured.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  plan_id TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tenants_email_idx ON tenants (email)`,
  `CREATE INDEX IF NOT EXISTS tenants_stripe_customer_idx ON tenants (stripe_customer_id)`,
  `CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys (key_hash)`,
  `CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id)`,
  `CREATE TABLE IF NOT EXISTS billing_usage (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  route TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period_key, route)
)`,
];

let ensured: Promise<void> | null = null;

export function ensureBillingSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      for (const stmt of STATEMENTS) await db.execute(sql.raw(stmt));
    })().catch((err) => {
      ensured = null; // retry on next call
      throw err;
    });
  }
  return ensured;
}
