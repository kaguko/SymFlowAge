const BASE = 'http://localhost:3000';
async function postJson(path, body, extraHeaders = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  let j = {};
  try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, json: j, headers: r.headers };
}
(async () => {
  console.log('--- 1. legacy key still works (backward compat) ---');
  const leg = await postJson('/api/v1/agent/guardrail/drift-check',
    { originalGoal: 'Ship MVP', agentOutput: 'Fix login bug' },
    { Authorization: 'Bearer test-agent-key' });
  console.log('legacy status=' + leg.status + ' decision=' + leg.json.decision);

  console.log('--- 2. issue metered key ---');
  const k = await postJson('/api/billing/api-keys', { email: 'founder@cogniflow.local', name: 'cline' });
  console.log('issue status=' + k.status + ' tenant=' + k.json.tenantId);
  const key = k.json.apiKey;

  console.log('--- 3. metered key works + quota headers ---');
  const m = await postJson('/api/v1/agent/guardrail/drift-check',
    { originalGoal: 'Ship MVP', agentOutput: 'Fix login bug' },
    { Authorization: 'Bearer ' + key });
  console.log('metered status=' + m.status + ' remaining=' + m.headers.get('x-quota-remaining') + ' plan=' + m.headers.get('x-tenant-plan'));

  console.log('--- 4. usage ---');
  const u = await fetch(BASE + '/api/billing/usage?tenantId=' + k.json.tenantId, { headers: { Authorization: 'Bearer ' + key } }).then((r) => r.json());
  console.log('used=' + u.used + ' quota=' + u.monthlyQuota + ' plan=' + u.planId);

  console.log('--- 5. checkout mock (no STRIPE key) ---');
  const c = await postJson('/api/billing/checkout', { email: 'founder@cogniflow.local', planId: 'pro' });
  console.log('checkout mode=' + c.json.mode + ' plan=' + c.json.planId);
})().catch((e) => console.log('ERR:' + e.message));
