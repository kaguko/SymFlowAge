/**
 * SymFlowAge Billing Store — tenants, hashed API keys and metered usage.
 *
 * Backend selection:
 *  - DATABASE_URL / SQL_HOST configured → Postgres is the single source of truth. A DB error is
 *    surfaced to the caller (auth fails closed with 503); it is never papered over with memory,
 *    because a key issued into memory would silently vanish on restart.
 *  - No database (local dev, tests, or SYMFLOWAGE_ALLOW_INMEMORY=1) → in-memory maps. Production
 *    refuses to boot in that state unless the escape hatch is set (see src/db/index.ts).
 *
 * API keys are 192+ bits of randomness, so a plain SHA-256 digest is the right at-rest form
 * (bcrypt/argon2 only help against low-entropy secrets and would add latency to every request).
 * The raw key is shown once at issuance and never stored or cached.
 */
import { randomUUID, createHash } from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, isDbConfigured } from '../db/index.ts';
import { tenants as tenantsTable, apiKeys as apiKeysTable, billingUsage } from '../db/schema.ts';
import { ensureBillingSchema } from './billingSchema.ts';
import { getPlan } from './plans.ts';

export interface TenantRecord {
  id: string;
  email: string;
  planId: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  createdAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  keyPrefix: string;
  keyHash: string;
  name: string;
  revoked: boolean;
  createdAt: Date;
  lastUsedAt?: Date | null;
}

const useDb = isDbConfigured;

if (!useDb) {
  console.warn('[billing] No database configured — tenants/API keys/usage are in-memory and LOST on restart.');
}

// ── In-memory backend (only when no DB is configured) ──────────────────────────────────────
const memTenants = new Map<string, TenantRecord>();
const memTenantsByEmail = new Map<string, string>();
const memKeys = new Map<string, ApiKeyRecord>(); // hash -> record
const memUsage = new Map<string, number>(); // `${tenantId}|${period}|${route}` -> count

// ── Helpers ────────────────────────────────────────────────────────────────────────────────
function periodKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentPeriod(): { start: Date; end: Date } {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export function getPeriodKey(): string {
  return periodKey();
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function toTenant(row: typeof tenantsTable.$inferSelect): TenantRecord {
  return {
    id: row.id,
    email: row.email,
    planId: row.planId,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    createdAt: row.createdAt,
  };
}

async function ready() {
  if (useDb) await ensureBillingSchema();
}

// Short-lived positive cache for key → tenant so the hot auth path does not hit Postgres on every
// request. TTL bounds how long a revocation/plan change made on another instance can lag.
const AUTH_CACHE_TTL_MS = 30_000;
const authCache = new Map<string, { tenant: TenantRecord; keyId: string; expiresAt: number }>();

function invalidateAuthCache(match?: { keyId?: string; tenantId?: string }) {
  for (const [hash, entry] of authCache) {
    if (!match || entry.keyId === match.keyId || entry.tenant.id === match.tenantId) authCache.delete(hash);
  }
}

// ── Tenants ────────────────────────────────────────────────────────────────────────────────
export async function getOrCreateTenant(email: string): Promise<TenantRecord> {
  const norm = email.trim().toLowerCase();
  const { start, end } = currentPeriod();
  const id = `tnt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  if (!useDb) {
    const existing = memTenants.get(memTenantsByEmail.get(norm) || '');
    if (existing) return existing;
    const t: TenantRecord = {
      id, email: norm, planId: 'free', status: 'active',
      currentPeriodStart: start, currentPeriodEnd: end, createdAt: new Date(),
    };
    memTenants.set(id, t);
    memTenantsByEmail.set(norm, id);
    return t;
  }

  await ready();
  await db
    .insert(tenantsTable)
    .values({ id, email: norm, currentPeriodStart: start, currentPeriodEnd: end })
    .onConflictDoNothing({ target: tenantsTable.email });
  const [row] = await db.select().from(tenantsTable).where(eq(tenantsTable.email, norm)).limit(1);
  return toTenant(row);
}

export async function getTenant(id: string): Promise<TenantRecord | undefined> {
  if (!useDb) return memTenants.get(id);
  await ready();
  const [row] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, id)).limit(1);
  return row ? toTenant(row) : undefined;
}

export async function updateTenantSubscription(
  tenantId: string,
  patch: Partial<TenantRecord>
): Promise<TenantRecord | undefined> {
  if (!useDb) {
    const t = memTenants.get(tenantId);
    if (!t) return undefined;
    Object.assign(t, patch);
    return t;
  }
  await ready();
  const set: Partial<typeof tenantsTable.$inferInsert> = {};
  if (patch.planId !== undefined) set.planId = patch.planId;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.stripeCustomerId !== undefined) set.stripeCustomerId = patch.stripeCustomerId;
  if (patch.stripeSubscriptionId !== undefined) set.stripeSubscriptionId = patch.stripeSubscriptionId;
  if (patch.currentPeriodStart !== undefined) set.currentPeriodStart = patch.currentPeriodStart;
  if (patch.currentPeriodEnd !== undefined) set.currentPeriodEnd = patch.currentPeriodEnd;
  if (Object.keys(set).length === 0) return getTenant(tenantId);
  const [row] = await db.update(tenantsTable).set(set).where(eq(tenantsTable.id, tenantId)).returning();
  invalidateAuthCache({ tenantId });
  return row ? toTenant(row) : undefined;
}

export async function findTenantByCustomerId(customerId: string): Promise<TenantRecord | undefined> {
  if (!useDb) {
    for (const t of memTenants.values()) if (t.stripeCustomerId === customerId) return t;
    return undefined;
  }
  await ready();
  const [row] = await db.select().from(tenantsTable).where(eq(tenantsTable.stripeCustomerId, customerId)).limit(1);
  return row ? toTenant(row) : undefined;
}

// ── API keys ───────────────────────────────────────────────────────────────────────────────
export async function issueApiKey(
  tenantId: string,
  name = 'default'
): Promise<{ rawKey: string; record: ApiKeyRecord }> {
  const rawKey = `sk_live_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const record: ApiKeyRecord = {
    id: `key_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    tenantId,
    keyPrefix: rawKey.slice(0, 12),
    keyHash: sha256(rawKey),
    name,
    revoked: false,
    createdAt: new Date(),
  };
  if (!useDb) {
    memKeys.set(record.keyHash, record);
  } else {
    await ready();
    await db.insert(apiKeysTable).values({
      id: record.id,
      tenantId,
      keyPrefix: record.keyPrefix,
      keyHash: record.keyHash,
      name,
    });
  }
  return { rawKey, record };
}

export async function listApiKeys(tenantId: string): Promise<Omit<ApiKeyRecord, 'keyHash'>[]> {
  const strip = ({ keyHash: _h, ...rest }: ApiKeyRecord) => rest;
  if (!useDb) return [...memKeys.values()].filter((k) => k.tenantId === tenantId).map(strip);
  await ready();
  const rows = await db.select().from(apiKeysTable).where(eq(apiKeysTable.tenantId, tenantId));
  return rows.map((r) =>
    strip({
      id: r.id, tenantId: r.tenantId, keyPrefix: r.keyPrefix, keyHash: r.keyHash, name: r.name,
      revoked: r.revokedAt !== null, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt,
    })
  );
}

/** Revoke a key belonging to `tenantId`. Returns false if no such active key exists for that tenant. */
export async function revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
  if (!useDb) {
    for (const rec of memKeys.values()) {
      if (rec.id === keyId && rec.tenantId === tenantId && !rec.revoked) {
        rec.revoked = true;
        invalidateAuthCache({ keyId });
        return true;
      }
    }
    return false;
  }
  await ready();
  const rows = await db
    .update(apiKeysTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeysTable.id, keyId), eq(apiKeysTable.tenantId, tenantId), isNull(apiKeysTable.revokedAt)))
    .returning({ id: apiKeysTable.id });
  invalidateAuthCache({ keyId });
  return rows.length > 0;
}

const lastUsedPending = new Map<string, number>(); // keyId -> ms

export async function resolveTenantByRawKey(rawKey: string): Promise<TenantRecord | undefined> {
  const hash = sha256(rawKey);
  const cached = authCache.get(hash);
  if (cached && cached.expiresAt > Date.now()) {
    lastUsedPending.set(cached.keyId, Date.now());
    return cached.tenant;
  }
  authCache.delete(hash);

  let tenant: TenantRecord | undefined;
  let keyId = '';
  if (!useDb) {
    const rec = memKeys.get(hash);
    if (rec && !rec.revoked) {
      tenant = memTenants.get(rec.tenantId);
      keyId = rec.id;
    }
  } else {
    await ready();
    const [row] = await db
      .select({ key: apiKeysTable, tenant: tenantsTable })
      .from(apiKeysTable)
      .innerJoin(tenantsTable, eq(apiKeysTable.tenantId, tenantsTable.id))
      .where(and(eq(apiKeysTable.keyHash, hash), isNull(apiKeysTable.revokedAt)))
      .limit(1);
    if (row) {
      tenant = toTenant(row.tenant);
      keyId = row.key.id;
    }
  }
  if (!tenant) return undefined;
  authCache.set(hash, { tenant, keyId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  lastUsedPending.set(keyId, Date.now());
  return tenant;
}

// ── Usage metering ─────────────────────────────────────────────────────────────────────────
// Counters are incremented in memory and flushed to Postgres in batches (`count = count + delta`).
// The persisted baseline is loaded once per tenant/period, so quotas survive restarts. With several
// instances each one sees the baseline as of its first request, so enforcement is approximate.
const usageBase = new Map<string, Map<string, number>>(); // `${tenantId}|${period}` -> route -> count
const usagePending = new Map<string, number>(); // `${tenantId}|${period}|${route}` -> delta

async function loadUsageBase(tenantId: string, pk: string): Promise<Map<string, number>> {
  const key = `${tenantId}|${pk}`;
  let base = usageBase.get(key);
  if (base) return base;
  base = new Map();
  if (useDb) {
    await ready();
    const rows = await db
      .select()
      .from(billingUsage)
      .where(and(eq(billingUsage.tenantId, tenantId), eq(billingUsage.periodKey, pk)));
    for (const r of rows) base.set(r.route, r.count);
  }
  usageBase.set(key, base);
  return base;
}

export async function recordUsage(tenantId: string, route: string): Promise<{ count: number; periodKey: string }> {
  const pk = periodKey();
  await loadUsageBase(tenantId, pk);
  const k = `${tenantId}|${pk}|${route}`;
  if (!useDb) {
    const count = (memUsage.get(k) || 0) + 1;
    memUsage.set(k, count);
    return { count, periodKey: pk };
  }
  const count = (usagePending.get(k) || 0) + 1;
  usagePending.set(k, count);
  return { count, periodKey: pk };
}

export async function flushBillingUsage(): Promise<void> {
  if (!useDb) return;
  const deltas = [...usagePending.entries()];
  const used = [...lastUsedPending.entries()];
  if (deltas.length === 0 && used.length === 0) return;
  usagePending.clear();
  lastUsedPending.clear();
  // Fold into the in-memory baseline synchronously so summaries never dip while the write is in flight.
  const bump = (k: string, d: number) => {
    const [tenantId, pk, ...rest] = k.split('|');
    const base = usageBase.get(`${tenantId}|${pk}`);
    const route = rest.join('|');
    if (base) base.set(route, Math.max(0, (base.get(route) || 0) + d));
  };
  for (const [k, delta] of deltas) bump(k, delta);
  try {
    await ready();
    for (const [k, delta] of deltas) {
      const [tenantId, pk, ...rest] = k.split('|');
      const route = rest.join('|');
      await db
        .insert(billingUsage)
        .values({ tenantId, periodKey: pk, route, count: delta })
        .onConflictDoUpdate({
          target: [billingUsage.tenantId, billingUsage.periodKey, billingUsage.route],
          set: { count: sql`${billingUsage.count} + ${delta}` },
        });
    }
    for (const [keyId, ts] of used) {
      await db.update(apiKeysTable).set({ lastUsedAt: new Date(ts) }).where(eq(apiKeysTable.id, keyId));
    }
  } catch (err) {
    // Put the counts back so nothing is lost; they are retried on the next flush.
    for (const [k, delta] of deltas) {
      bump(k, -delta);
      usagePending.set(k, (usagePending.get(k) || 0) + delta);
    }
    for (const [keyId, ts] of used) if (!lastUsedPending.has(keyId)) lastUsedPending.set(keyId, ts);
    console.error('[billing] usage flush failed, will retry:', (err as Error)?.message || err);
  }
}

if (useDb) {
  setInterval(() => void flushBillingUsage(), 5_000).unref();
}

export async function getUsageSummary(tenantId: string, knownTenant?: TenantRecord) {
  const pk = periodKey();
  const t = knownTenant ?? (await getTenant(tenantId));
  const plan = getPlan(t?.planId || 'free');
  const byRoute: Record<string, number> = {};

  if (!useDb) {
    for (const [k, v] of memUsage.entries()) {
      const [tid, p, ...rest] = k.split('|');
      if (tid === tenantId && p === pk) byRoute[rest.join('|')] = v;
    }
  } else {
    const base = await loadUsageBase(tenantId, pk);
    for (const [route, n] of base) byRoute[route] = n;
    for (const [k, delta] of usagePending) {
      const [tid, p, ...rest] = k.split('|');
      if (tid === tenantId && p === pk) {
        const route = rest.join('|');
        byRoute[route] = (byRoute[route] || 0) + delta;
      }
    }
  }

  const total = Object.values(byRoute).reduce((a, b) => a + b, 0);
  const overage = Math.max(0, total - plan.monthlyQuota);
  return {
    tenantId,
    planId: plan.id,
    planName: plan.name,
    periodKey: pk,
    monthlyQuota: plan.monthlyQuota,
    used: total,
    remaining: Math.max(0, plan.monthlyQuota - total),
    overageCalls: overage,
    overageUsd: Math.round(overage * plan.overagePerCallUsd * 100) / 100,
    byRoute,
  };
}

export async function checkQuota(
  tenantId: string,
  knownTenant?: TenantRecord
): Promise<{ allowed: boolean; summary: Awaited<ReturnType<typeof getUsageSummary>> }> {
  const summary = await getUsageSummary(tenantId, knownTenant);
  // Free plan: hard block at quota. Paid: allow with overage billing.
  if (summary.planId === 'free' && summary.used >= summary.monthlyQuota) {
    return { allowed: false, summary };
  }
  return { allowed: true, summary };
}
