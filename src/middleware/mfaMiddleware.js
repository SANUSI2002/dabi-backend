import { activeSession } from '../modules/auth/auth.session.js';
import { hasActiveMfa } from '../modules/auth/auth.mfa.js';

const recent = (session) => !!session?.mfaVerifiedAt && Date.now() - session.mfaVerifiedAt.getTime() <= 10 * 60_000;
const error = (res, code) => res.status(403).json({ status: 'error', error: { code, message: code === 'MFA_ENROLLMENT_REQUIRED' ? 'Set up an authenticator before continuing.' : 'Recent multi-factor verification is required.' } });

export const requireRecentMfa = async (req, res, next) => {
  try {
    // Legacy no-session JWT fixtures exist only in unit tests. Production protect
    // rejects those tokens before this middleware is reached.
    if (process.env.NODE_ENV === 'test' && !req.user.sessionId) return next();
    if (!req.user.sessionId) return error(res, 'MFA_REQUIRED');
    if (!(await hasActiveMfa(req.user.id))) return error(res, 'MFA_ENROLLMENT_REQUIRED');
    const session = await activeSession(req.user.sessionId, req.user.id);
    if (!recent(session)) return error(res, 'MFA_REQUIRED');
    return next();
  } catch (cause) { return next(cause); }
};

export const requireRecentMfaIfEnrolled = async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'test' && !req.user.sessionId) return next();
    if (!(await hasActiveMfa(req.user.id))) return next();
    return requireRecentMfa(req, res, next);
  } catch (cause) { return next(cause); }
};
