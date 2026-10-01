import { Request } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { resolveTenantByRawKey, findTenantByEmail, TenantRecord } from './billingStore.ts';

export type BillingPrincipal =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'key'; tenant: TenantRecord }
  | { kind: 'firebase'; uid: string; email: string };

export function bearerToken(req: Request): string {
  const h = req.header('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Firebase ID token → verified identity. Unverified emails are rejected: the email is the tenant key. */
export async function verifyFirebaseIdentity(token: string): Promise<{ uid: string; email: string } | null> {
  if (token.split('.').length !== 3) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    if (!decoded.email || decoded.email_verified !== true) return null;
    return { uid: decoded.uid, email: decoded.email.trim().toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Who is calling the billing API? A tenant API key (`sk_live_…`) or a verified Firebase user.
 * `none` = no credentials; `invalid` = credentials presented but not accepted. Store errors propagate.
 */
export async function resolveBillingPrincipal(req: Request): Promise<BillingPrincipal> {
  const token = bearerToken(req);
  if (!token) return { kind: 'none' };
  if (token.startsWith('sk_live_')) {
    const tenant = await resolveTenantByRawKey(token);
    return tenant ? { kind: 'key', tenant } : { kind: 'invalid' };
  }
  const id = await verifyFirebaseIdentity(token);
  return id ? { kind: 'firebase', ...id } : { kind: 'invalid' };
}

/** The tenant a principal acts for (a Firebase user maps to the tenant registered under their verified email). */
export async function tenantForPrincipal(p: BillingPrincipal): Promise<TenantRecord | undefined> {
  if (p.kind === 'key') return p.tenant;
  if (p.kind === 'firebase') return findTenantByEmail(p.email);
  return undefined;
}
