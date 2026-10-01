import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';

// Needs a real Postgres: TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/db npx playwright test tests/billing-persistence.spec.ts
const dbUrl = process.env.TEST_DATABASE_URL;
const PORT = 3107;
const base = `http://127.0.0.1:${PORT}`;

function startServer(): Promise<ChildProcess> {
  const child = spawn('npx', ['tsx', 'server.ts'], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: dbUrl!, NODE_ENV: 'development', DISABLE_HMR: 'true', GEMINI_API_KEY: '' },
    stdio: 'ignore',
    detached: true,
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000;
    const poll = async () => {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return resolve(child);
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return reject(new Error('server did not start'));
      setTimeout(poll, 500);
    };
    poll();
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
  // Wait until the port is actually released so a restart cannot talk to the dying instance.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await fetch(`${base}/api/health`); } catch { return; }
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.describe('Tenant / API key persistence (Postgres)', () => {
  test.skip(!dbUrl, 'TEST_DATABASE_URL not set');
  test.describe.configure({ mode: 'serial' });

  const email = `persist-${Date.now()}@example.com`;
  let server: ChildProcess;
  let apiKey = '';
  let keyId = '';
  let tenantId = '';

  test.beforeAll(async () => { server = await startServer(); });
  test.afterAll(async () => { if (server) await stopServer(server); });

  test('issues a key and it authenticates; only the hash is stored', async () => {
    const res = await fetch(`${base}/api/billing/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name: 'ci' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    apiKey = body.apiKey; tenantId = body.tenantId;
    expect(apiKey).toMatch(/^sk_live_/);

    const authed = await fetch(`${base}/api/v1/agent/guardrail/exemptions`, { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(authed.status).toBe(200);

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl });
    const rows = (await pool.query('SELECT id, key_hash, key_prefix FROM api_keys WHERE tenant_id = $1', [tenantId])).rows;
    await pool.end();
    expect(rows).toHaveLength(1);
    keyId = rows[0].id;
    expect(rows[0].key_hash).toHaveLength(64);
    expect(rows[0].key_hash).not.toContain(apiKey);
    expect(JSON.stringify(rows[0])).not.toContain(apiKey.slice(12));
  });

  test('tenant, key and metered usage survive a server restart', async () => {
    await stopServer(server); // SIGTERM flushes buffered usage
    server = await startServer();

    const authed = await fetch(`${base}/api/v1/agent/guardrail/exemptions`, { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(authed.status).toBe(200);

    const usage = await (await fetch(`${base}/api/billing/usage?tenantId=${tenantId}`, { headers: { Authorization: `Bearer ${apiKey}` } })).json();
    expect(usage.tenantId).toBe(tenantId);
    expect(usage.used).toBeGreaterThanOrEqual(2);

    // Unauthenticated signup must not mint a key for an existing tenant...
    const hijack = await fetch(`${base}/api/billing/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    expect(hijack.status).toBe(409);
    expect(JSON.stringify(await hijack.json())).not.toContain('sk_live_');

    // ...but the tenant itself (authenticated) can add another key, under the same tenant.
    const again = await fetch(`${base}/api/billing/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ name: 'second' }),
    });
    expect(again.status).toBe(201);
    expect((await again.json()).tenantId).toBe(tenantId);
  });

  test('a revoked key returns 401, immediately and after restart', async () => {
    const list = await (await fetch(`${base}/api/billing/api-keys`, { headers: { Authorization: `Bearer ${apiKey}` } })).json();
    expect(list.keys.map((k: any) => k.id)).toContain(keyId);
    expect(JSON.stringify(list)).not.toContain(apiKey);

    const revoke = await fetch(`${base}/api/billing/api-keys/${keyId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } });
    expect(revoke.status).toBe(200);

    const after = await fetch(`${base}/api/v1/agent/guardrail/exemptions`, { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(after.status).toBe(401);

    await stopServer(server);
    server = await startServer();
    const afterRestart = await fetch(`${base}/api/v1/agent/guardrail/exemptions`, { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(afterRestart.status).toBe(401);
  });

  test("a tenant cannot revoke another tenant's key", async () => {
    const mk = async (e: string) => (await (await fetch(`${base}/api/billing/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e }),
    })).json());
    const a = await mk(`a-${Date.now()}@example.com`);
    const b = await mk(`b-${Date.now()}@example.com`);
    const bKeys = await (await fetch(`${base}/api/billing/api-keys`, { headers: { Authorization: `Bearer ${b.apiKey}` } })).json();
    const del = await fetch(`${base}/api/billing/api-keys/${bKeys.keys[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${a.apiKey}` } });
    expect(del.status).toBe(404);
    const stillWorks = await fetch(`${base}/api/v1/agent/guardrail/exemptions`, { headers: { Authorization: `Bearer ${b.apiKey}` } });
    expect(stillWorks.status).toBe(200);
  });
});

test.describe('Billing access control (production mode)', () => {
  test.skip(!dbUrl, 'TEST_DATABASE_URL not set');
  test.describe.configure({ mode: 'serial' });

  const PROD_PORT = 3108;
  const prod = `http://127.0.0.1:${PROD_PORT}`;
  let devServer: ChildProcess;
  let prodServer: ChildProcess;
  let a: { apiKey: string; tenantId: string };
  let b: { apiKey: string; tenantId: string };

  async function waitUp(url: string) {
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`server at ${url} did not start`);
  }

  test.beforeAll(async () => {
    // A dev-mode server (open signup) only to mint two tenants; the production server is what is under test.
    devServer = await startServer();
    const mk = async (email: string) => (await fetch(`${base}/api/billing/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    })).json();
    a = await mk(`prod-a-${Date.now()}@example.com`);
    b = await mk(`prod-b-${Date.now()}@example.com`);
    prodServer = spawn('npx', ['tsx', 'server.ts'], {
      env: { ...process.env, PORT: String(PROD_PORT), DATABASE_URL: dbUrl!, NODE_ENV: 'production', SYMFLOWAGE_M2M_API_KEY: 'prod-legacy-key', GEMINI_API_KEY: '' },
      stdio: 'ignore', detached: true,
    });
    await waitUp(prod);
  });
  test.afterAll(async () => {
    for (const c of [prodServer, devServer]) { try { process.kill(-c.pid!, 'SIGTERM'); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 1500));
  });

  const json = { 'Content-Type': 'application/json' };

  test('POST /api/billing/api-keys needs real credentials in production', async () => {
    const anon = await fetch(`${prod}/api/billing/api-keys`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'victim@example.com' }) });
    expect(anon.status).toBe(401);
    const forged = await fetch(`${prod}/api/billing/api-keys`, { method: 'POST', headers: { ...json, Authorization: 'Bearer aaa.bbb.ccc' }, body: JSON.stringify({ email: 'victim@example.com' }) });
    expect(forged.status).toBe(401);
    const bad = await fetch(`${prod}/api/billing/api-keys`, { method: 'POST', headers: { ...json, Authorization: 'Bearer sk_live_doesnotexist' }, body: '{}' });
    expect(bad.status).toBe(401);
  });

  test('an existing tenant key can still rotate/add keys in production, for its own tenant only', async () => {
    const res = await fetch(`${prod}/api/billing/api-keys`, { method: 'POST', headers: { ...json, Authorization: `Bearer ${a.apiKey}` }, body: JSON.stringify({ email: 'ignored@example.com', name: 'rot' }) });
    expect(res.status).toBe(201);
    expect((await res.json()).tenantId).toBe(a.tenantId); // body email is ignored
  });

  test('GET /api/billing/usage requires auth and is limited to the caller tenant', async () => {
    expect((await fetch(`${prod}/api/billing/usage?tenantId=${a.tenantId}`)).status).toBe(401);
    expect((await fetch(`${prod}/api/billing/usage?tenantId=${a.tenantId}`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);

    const own = await fetch(`${prod}/api/billing/usage?tenantId=${a.tenantId}`, { headers: { Authorization: `Bearer ${a.apiKey}` } });
    expect(own.status).toBe(200);
    expect((await own.json()).tenantId).toBe(a.tenantId);

    const implicit = await fetch(`${prod}/api/billing/usage`, { headers: { Authorization: `Bearer ${a.apiKey}` } });
    expect((await implicit.json()).tenantId).toBe(a.tenantId);

    const other = await fetch(`${prod}/api/billing/usage?tenantId=${b.tenantId}`, { headers: { Authorization: `Bearer ${a.apiKey}` } });
    expect(other.status).toBe(403);
  });
});

