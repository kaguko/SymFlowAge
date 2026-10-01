import { test, expect } from '@playwright/test';

const baseUrl = 'http://localhost:3000';
const json = { 'Content-Type': 'application/json' };

async function issueKey(email: string) {
  const res = await fetch(`${baseUrl}/api/billing/api-keys`, { method: 'POST', headers: json, body: JSON.stringify({ email }) });
  expect(res.status).toBe(201);
  return (await res.json()) as { apiKey: string; tenantId: string };
}

/** Open the activity stream and return a handle that collects everything received until stop(). */
async function openStream(headers: Record<string, string>, query = '') {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/agent/activity/stream${query}`, { headers, signal: controller.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    } catch { /* aborted */ }
  })();
  return {
    get text() { return text; },
    async stop() { controller.abort(); await pump; },
  };
}

async function callTool(apiKey: string, agentId: string) {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { ...json, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'symflowage_get_accuracy_score', arguments: { agentId } },
    }),
  });
  expect(res.status).toBe(200);
}

const settle = () => new Promise((r) => setTimeout(r, 600));

test.describe('Activity stream tenant isolation', () => {
  test('tenant A never sees tenant B (or legacy-key) events, and vice versa', async () => {
    const stamp = Date.now();
    const a = await issueKey(`iso-a-${stamp}@example.com`);
    const b = await issueKey(`iso-b-${stamp}@example.com`);
    const legacy = { Authorization: 'Bearer test-agent-key' };

    const streamA = await openStream({ Authorization: `Bearer ${a.apiKey}` });
    const streamB = await openStream({ Authorization: `Bearer ${b.apiKey}` });
    const streamLegacy = await openStream(legacy);

    await callTool(a.apiKey, `agent-of-A-${stamp}`);
    await callTool(b.apiKey, `agent-of-B-${stamp}`);
    await callTool('test-agent-key', `agent-legacy-${stamp}`);
    await settle();

    try {
      expect(streamA.text).toContain(`agent-of-A-${stamp}`);
      expect(streamA.text).not.toContain(`agent-of-B-${stamp}`);
      expect(streamA.text).not.toContain(`agent-legacy-${stamp}`);

      expect(streamB.text).toContain(`agent-of-B-${stamp}`);
      expect(streamB.text).not.toContain(`agent-of-A-${stamp}`);
      expect(streamB.text).not.toContain(`agent-legacy-${stamp}`);

      expect(streamLegacy.text).toContain(`agent-legacy-${stamp}`);
      expect(streamLegacy.text).not.toContain(`agent-of-A-${stamp}`);
      expect(streamLegacy.text).not.toContain(`agent-of-B-${stamp}`);
    } finally {
      await Promise.all([streamA.stop(), streamB.stop(), streamLegacy.stop()]);
    }
  });

  test('a stream ticket is bound to the tenant that requested it', async () => {
    const stamp = Date.now();
    const a = await issueKey(`iso-ta-${stamp}@example.com`);
    const b = await issueKey(`iso-tb-${stamp}@example.com`);

    const t = await fetch(`${baseUrl}/api/agent/activity/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${a.apiKey}` } });
    const { ticket } = await t.json();
    const stream = await openStream({}, `?ticket=${ticket}`);

    await callTool(b.apiKey, `ticket-B-${stamp}`);
    await callTool(a.apiKey, `ticket-A-${stamp}`);
    await settle();
    try {
      expect(stream.text).toContain(`ticket-A-${stamp}`);
      expect(stream.text).not.toContain(`ticket-B-${stamp}`);
    } finally {
      await stream.stop();
    }
  });

  test('circuit-breaker alerts on the MCP SSE channel stay inside the tenant', async () => {
    const stamp = Date.now();
    const a = await issueKey(`iso-ca-${stamp}@example.com`);
    const b = await issueKey(`iso-cb-${stamp}@example.com`);

    const open = async (key: string) => {
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/mcp/sse`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); } } catch { /* aborted */ } })();
      return { get text() { return text; }, async stop() { controller.abort(); await pump; } };
    };
    const sseA = await open(a.apiKey);
    const sseB = await open(b.apiKey);

    // Tenant A's agent drifts hard; the alert must reach A only.
    await fetch(`${baseUrl}/api/v1/agent/guardrail/drift-check`, {
      method: 'POST',
      headers: { ...json, Authorization: `Bearer ${a.apiKey}`, 'x-agent-id': `iso-agent-${stamp}` },
      body: JSON.stringify({
        originalGoal: 'Build a Node.js payment API',
        agentOutput: 'Dựng Kubernetes multi-region cluster cho hệ thống analytics',
        circuitBreakerThreshold: 10,
      }),
    });
    await settle();
    try {
      expect(sseA.text).toContain(`iso-agent-${stamp}`);
      expect(sseB.text).not.toContain(`iso-agent-${stamp}`);
      expect(sseB.text).not.toContain('guardrail_alert');
    } finally {
      await Promise.all([sseA.stop(), sseB.stop()]);
    }
  });
});
