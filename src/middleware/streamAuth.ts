import { randomBytes } from 'crypto';
import { Response, NextFunction } from 'express';
import { requireAgentAuth, agentScope, AgentRequest } from './agentAuth.ts';
import { verifyFirebaseIdentity } from '../billing/billingAuth.ts';
import { findTenantByEmail } from '../billing/billingStore.ts';

const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 5_000;

// Browsers cannot set an Authorization header on EventSource, so an authenticated caller first
// exchanges its credentials for a single-use, 30s ticket and opens the stream with ?ticket=.
// Tickets never carry the long-lived secret, so it does not end up in URLs or proxy logs.
const tickets = new Map<string, { scope: string; expiresAt: number }>();

export type StreamRequest = AgentRequest & { streamScope?: string };

function sweepTickets(now = Date.now()) {
  for (const [id, t] of tickets) if (t.expiresAt <= now) tickets.delete(id);
}

function consumeTicket(ticket: string): string | null {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  return entry.expiresAt > Date.now() ? entry.scope : null;
}

function issue(res: Response, scope: string) {
  sweepTickets();
  if (tickets.size >= MAX_TICKETS) return res.status(429).json({ error: 'too_many_stream_tickets' });
  const ticket = randomBytes(24).toString('hex');
  tickets.set(ticket, { scope, expiresAt: Date.now() + TICKET_TTL_MS });
  return res.json({ ticket, expiresInSeconds: TICKET_TTL_MS / 1000 });
}

/** POST /api/agent/activity/ticket — Firebase ID token (browser user) or agent/tenant API key. */
export async function issueStreamTicket(req: AgentRequest, res: Response, next: NextFunction) {
  const authorization = req.header('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'invalid_stream_credentials' });

  // Firebase ID token (browser user). Only a verified email is accepted; the stream is scoped to the tenant
  // registered under that email, and a user with no tenant gets a private scope that receives no events.
  const identity = await verifyFirebaseIdentity(token);
  if (identity) {
    try {
      const tenant = await findTenantByEmail(identity.email);
      return issue(res, tenant ? `tenant:${tenant.id}` : `user:${identity.uid}`);
    } catch (err) {
      console.error('[streamAuth] tenant lookup failed:', (err as Error)?.message || err);
      return res.status(503).json({ error: 'auth_backend_unavailable' });
    }
  }
  return requireAgentAuth(req, res, () => {
    issue(res, agentScope(req));
  });
}

/** Guards GET /api/agent/activity/stream: single-use ticket, or an agent/tenant API key header. */
export function requireStreamAuth(req: StreamRequest, res: Response, next: NextFunction) {
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  if (ticket) {
    const scope = consumeTicket(ticket);
    if (!scope) return res.status(401).json({ error: 'invalid_or_expired_stream_ticket' });
    req.streamScope = scope;
    return next();
  }
  if (req.header('authorization')) {
    return requireAgentAuth(req, res, () => {
      req.streamScope = agentScope(req);
      next();
    });
  }
  return res.status(401).json({ error: 'invalid_stream_credentials' });
}
