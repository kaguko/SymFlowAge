import { Request, Response, NextFunction } from 'express';
import { resolveTenantByRawKey, recordUsage, checkQuota } from '../billing/billingStore.ts';

export interface AgentRequest extends Request {
  agentId?: string;
  tenantId?: string;
}

/** Isolation scope for events/alerts: a tenant's own key sees only that tenant's traffic; the legacy shared key sees the legacy pool. */
export const agentScope = (req: { tenantId?: string }) => (req.tenantId ? `tenant:${req.tenantId}` : 'legacy');

export async function requireAgentAuth(req: AgentRequest, res: Response, next: NextFunction) {
  const configuredKey = process.env.SYMFLOWAGE_M2M_API_KEY || (process.env.NODE_ENV !== 'production' ? 'test-agent-key' : undefined);
  const authorization = req.header('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: 'invalid_agent_credentials' });
  }

  // 1. Metered per-tenant key (sk_live_...) - primary monetization path
  let tenant;
  try {
    tenant = await resolveTenantByRawKey(token);
  } catch (err) {
    // Fail closed: if the key store is unreachable we cannot prove the key is valid or unrevoked.
    console.error('[agentAuth] key store unavailable:', (err as Error)?.message || err);
    return res.status(503).json({ error: 'auth_backend_unavailable' });
  }
  if (tenant) {
    const quota = await checkQuota(tenant.id, tenant);
    if (!quota.allowed) {
      return res.status(402).json({
        error: 'quota_exceeded',
        message: `Monthly quota exhausted (${quota.summary.used}/${quota.summary.monthlyQuota}). Upgrade at /pricing.`,
        usage: quota.summary,
      });
    }
    req.tenantId = tenant.id;
    req.agentId = req.header('x-agent-id') || 'anonymous-agent';
    await recordUsage(tenant.id, req.path || req.url);
    res.setHeader('X-Quota-Remaining', String(quota.summary.remaining));
    res.setHeader('X-Tenant-Plan', quota.summary.planId);
    return next();
  }

  // 2. Legacy single-key path (backward compatible: SYMFLOWAGE_M2M_API_KEY / test-agent-key)
  if (!configuredKey) {
    return res.status(503).json({
      error: 'agent_api_not_configured',
      message: 'Set SYMFLOWAGE_M2M_API_KEY before enabling the versioned agent API.',
    });
  }
  if (token !== configuredKey) {
    return res.status(401).json({ error: 'invalid_agent_credentials' });
  }

  req.agentId = req.header('x-agent-id') || 'anonymous-agent';
  return next();
}
