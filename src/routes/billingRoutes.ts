import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { BILLING_PLANS, getPlan, resolvePriceId } from '../billing/plans.ts';
import {
  getOrCreateTenant,
  getTenant,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  resolveTenantByRawKey,
  getUsageSummary,
  updateTenantSubscription,
  findTenantByCustomerId,
} from '../billing/billingStore.ts';

export const billingRouter = Router();

const isProduction = process.env.NODE_ENV === 'production';

function bearer(req: Request): string {
  const h = req.header('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Resolve the tenant that owns the presented `sk_live_…` key (the key itself is the credential). */
async function authTenant(req: Request, res: Response) {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: 'invalid_agent_credentials' });
    return undefined;
  }
  try {
    const tenant = await resolveTenantByRawKey(token);
    if (!tenant) res.status(401).json({ error: 'invalid_agent_credentials' });
    return tenant;
  } catch (err) {
    console.error('[billing] key store unavailable:', (err as Error)?.message || err);
    res.status(503).json({ error: 'auth_backend_unavailable' });
    return undefined;
  }
}

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.trim() === '') return null;
  return new Stripe(key.trim());
}

// GET /api/billing/plans - public pricing catalog
billingRouter.get('/plans', (_req: Request, res: Response) => {
  return res.json({
    plans: Object.values(BILLING_PLANS),
    overageNote: 'Free blocks at quota. Pro/Team continue with $0.002/call overage.',
    byokNote: 'Customers bring their own GEMINI_API_KEY (BYOK) - SymFlowAge only meters guardrail logic.',
  });
});

// POST /api/billing/api-keys - issue a metered M2M key (BYOK-friendly)
billingRouter.post('/api-keys', async (req: Request, res: Response) => {
 try {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email is required' });
  const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 60) : 'default';
  const tenant = await getOrCreateTenant(email);
  const { rawKey, record } = await issueApiKey(tenant.id, name);
  return res.status(201).json({
    tenantId: tenant.id,
    email: tenant.email,
    planId: tenant.planId,
    apiKey: rawKey,
    keyPrefix: record.keyPrefix,
    usage: await getUsageSummary(tenant.id, tenant),
    mcpConfig: {
      url: `${process.env.APP_URL || 'http://localhost:3000'}/api/mcp/sse`,
      headers: { Authorization: `Bearer ${rawKey}` },
    },
  });
 } catch (err: any) {
  console.error('[billing/api-keys] failed:', err?.message || err);
  return res.status(500).json({ error: 'api_key_issue_failed' });
 }
});

// GET /api/billing/api-keys - list this tenant's keys (prefix/metadata only, never the secret)
billingRouter.get('/api-keys', async (req: Request, res: Response) => {
  const tenant = await authTenant(req, res);
  if (!tenant) return;
  return res.json({ tenantId: tenant.id, keys: await listApiKeys(tenant.id) });
});

// DELETE /api/billing/api-keys/:id - revoke one of this tenant's keys (takes effect immediately on this
// instance; other instances within the 30s auth-cache TTL)
billingRouter.delete('/api-keys/:id', async (req: Request, res: Response) => {
  const tenant = await authTenant(req, res);
  if (!tenant) return;
  const revoked = await revokeApiKey(tenant.id, String(req.params.id));
  return revoked ? res.json({ revoked: true }) : res.status(404).json({ error: 'key_not_found' });
});

// GET /api/billing/usage?tenantId=xxx
billingRouter.get('/usage', async (req: Request, res: Response) => {
  try {
    const tenantId = String(req.query.tenantId || '');
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
    const t = await getTenant(tenantId);
    if (!t) return res.status(404).json({ error: 'tenant_not_found' });
    return res.json(await getUsageSummary(tenantId, t));
  } catch (err: any) {
    console.error('[billing/usage] failed:', err?.message || err);
    return res.status(500).json({ error: 'usage_failed' });
  }
});

// POST /api/billing/checkout - create Stripe Checkout Session (or mock when no key)
billingRouter.post('/checkout', async (req: Request, res: Response) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const planId = typeof req.body?.planId === 'string' ? req.body.planId : 'pro';
    const plan = getPlan(planId);
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email is required' });
    if (plan.id === 'free') return res.status(400).json({ error: 'free plan needs no checkout' });

    const tenant = await getOrCreateTenant(email);
    const priceId = resolvePriceId(plan.id);
    const stripe = getStripe();
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

    if (!stripe || !priceId) {
      // Mock mode: no STRIPE_SECRET_KEY yet - return upgrade intent so frontend can proceed.
      // Never grant a paid plan without payment in production.
      if (isProduction) return res.status(503).json({ error: 'billing_not_configured' });
      await updateTenantSubscription(tenant.id, { planId: plan.id, status: 'pending_checkout' });
      return res.json({
        mode: 'mock',
        message: 'Set STRIPE_SECRET_KEY + STRIPE_PRICE_* to enable live checkout.',
        tenantId: tenant.id,
        planId: plan.id,
        checkoutUrl: `${appUrl}/pricing?plan=${plan.id}&tenant=${tenant.id}&mock=1`,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/pricing?cancelled=1`,
      metadata: { tenantId: tenant.id, planId: plan.id },
    });
    await updateTenantSubscription(tenant.id, { planId: plan.id, status: 'pending_checkout' });
    return res.json({ mode: 'live', tenantId: tenant.id, planId: plan.id, checkoutUrl: session.url });
  } catch (err: any) {
    console.error('[billing/checkout] failed:', err?.message || err);
    return res.status(500).json({ error: 'checkout_failed' });
  }
});

// POST /api/billing/webhook - Stripe webhook (idempotent)
billingRouter.post('/webhook', async (req: Request, res: Response) => {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  try {
    let event: Stripe.Event;
    if (stripe && webhookSecret) {
      const sig = req.headers['stripe-signature'] as string;
      // NOTE: requires express.raw for this route (mounted before express.json)
      event = stripe.webhooks.constructEvent((req as any).body, sig, webhookSecret);
    } else {
      // Unsigned events are a local-testing convenience only; in production anyone could forge a plan upgrade.
      if (isProduction) return res.status(503).json({ error: 'billing_not_configured' });
      event = req.body;
    }

    const type = (event as any)?.type || '';
    const obj: any = (event as any)?.data?.object || {};

    if (type === 'checkout.session.completed') {
      const tenantId = obj?.metadata?.tenantId;
      const planId = obj?.metadata?.planId || 'pro';
      if (tenantId) {
        await updateTenantSubscription(tenantId, {
          planId,
          status: 'active',
          stripeCustomerId: obj?.customer || null,
          stripeSubscriptionId: obj?.subscription || null,
          currentPeriodStart: new Date(),
        });
      }
    }
    if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
      const customerId = obj?.customer;
      const t = customerId ? await findTenantByCustomerId(String(customerId)) : undefined;
      if (t) {
        await updateTenantSubscription(t.id, {
          status: type.includes('deleted') ? 'cancelled' : obj?.status || t.status,
          planId: type.includes('deleted') ? 'free' : t.planId,
        });
      }
    }
    return res.json({ received: true, type });
  } catch (err: any) {
    console.error('[billing/webhook] failed:', err?.message || err);
    return res.status(400).json({ error: 'webhook_failed' });
  }
});
