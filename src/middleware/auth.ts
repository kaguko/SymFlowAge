import { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { DecodedIdToken } from 'firebase-admin/auth';

export interface AuthRequest extends Request {
  user?: DecodedIdToken | { uid: string; email: string };
}

const GUEST_USER = { uid: 'guest_user_cogniflow', email: 'developer@cogniflow.local' };

// Guest mode (no token) is a dev/demo convenience. In production it is off unless explicitly enabled.
// A token that is present but invalid is never downgraded to guest, in any environment.
const guestAllowed = () =>
  process.env.NODE_ENV !== 'production' || process.env.SYMFLOWAGE_ALLOW_GUEST === '1';

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (!guestAllowed()) {
      return res.status(401).json({ error: 'authentication_required' });
    }
    req.user = GUEST_USER;
    return next();
  }

  const token = authHeader.slice('Bearer '.length).trim();
  try {
    req.user = await adminAuth.verifyIdToken(token);
    return next();
  } catch (error) {
    console.warn('Firebase token verification failed:', (error as Error)?.message || error);
    return res.status(401).json({ error: 'invalid_auth_token' });
  }
};
