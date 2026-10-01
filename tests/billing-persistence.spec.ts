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

    const usage = await (await fetch(`${base}/api/billing/usage?tenantId=${tenantId}`)).json();
    expect(usage.tenantId).toBe(tenantId);
    expect(usage.used).toBeGreaterThanOrEqual(2);

    const again = await (await fetch(`${base}/api/billing/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    })).json();
    expect(again.tenantId).toBe(tenantId); // same tenant, not a new one
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
