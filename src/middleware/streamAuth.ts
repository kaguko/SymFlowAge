import { randomBytes } from 'crypto';
import { Response, NextFunction } from 'express';
import { requireAgentAuth, AgentRequest } from './agentAuth.ts';
import { adminAuth } from '../lib/firebase-admin.ts';

const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 5_000;

// Browsers cannot set an Authorization header on EventSource, so an authenticated caller first
// exchanges its credentials for a single-use, 30s ticket and opens the stream with ?ticket=.
// Tickets never carry the long-lived secret, so it does not end up in URLs or proxy logs.
const tickets = new Map<string, { subject: string; expiresAt: number }>();

function sweepTickets(now = Date.now()) {
  for (const [id, t] of tickets) if (t.expiresAt <= now) tickets.delete(id);
}

function consumeTicket(ticket: string): string | null {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  return entry.expiresAt > Date.now() ? entry.subject : null;
}

function issue(res: Response, subject: string) {
  sweepTickets();
  if (tickets.size >= MAX_TICKETS) return res.status(429).json({ error: 'too_many_stream_tickets' });
  const ticket = randomBytes(24).toString('hex');
  tickets.set(ticket, { subject, expiresAt: Date.now() + TICKET_TTL_MS });
  return res.json({ ticket, expiresInSeconds: TICKET_TTL_MS / 1000 });
}

/** POST /api/agent/activity/ticket — Firebase ID token (browser user) or agent/tenant API key. */
export async function issueStreamTicket(req: AgentRequest, res: Response, next: NextFunction) {
  const authorization = req.header('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'invalid_stream_credentials' });

  // Firebase ID tokens are JWTs; verified strictly (no guest fallback).
  if (token.split('.').length === 3) {
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      return issue(res, `user:${decoded.uid}`);
    } catch {
      // not a valid Firebase token — fall through to API-key auth
    }
  }
  return requireAgentAuth(req, res, () => {
    issue(res, `agent:${req.tenantId || req.agentId || 'anonymous-agent'}`);
  });
}

/** Guards GET /api/agent/activity/stream: single-use ticket, or an agent/tenant API key header. */
export function requireStreamAuth(req: AgentRequest, res: Response, next: NextFunction) {
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  if (ticket) {
    if (consumeTicket(ticket)) return next();
    return res.status(401).json({ error: 'invalid_or_expired_stream_ticket' });
  }
  if (req.header('authorization')) return requireAgentAuth(req, res, next);
  return res.status(401).json({ error: 'invalid_stream_credentials' });
}
