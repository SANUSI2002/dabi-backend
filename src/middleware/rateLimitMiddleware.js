import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

const secret = () => process.env.RATE_LIMIT_KEY_SECRET || process.env.JWT_SECRET || 'development-only-rate-limit-key';
const digest = (value) => crypto.createHmac('sha256', secret()).update(String(value || '')).digest('hex');
const ipKey = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
const identity = (req, field) => digest(req.body?.[field] || req.params?.[field] || 'anonymous');
export const rateLimitKey = (kind, field) => (req) => `${kind}:${digest(ipKey(req))}:${field ? identity(req, field) : 'ip'}`;

// The account behind a *verified* access token. Keying on it cannot be gamed with forged
// tokens (each would need our signature); anything unverifiable falls back to the IP.
const verifiedUserId = (req) => {
  if (req.rateLimitUserId !== undefined) return req.rateLimitUserId;
  const match = /^Bearer ([^\s]+)$/.exec(req.get?.('authorization') || req.headers?.authorization || '');
  let userId = null;
  if (match && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(match[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });
      const id = decoded.sub || decoded.id || decoded.userId;
      if (typeof id === 'string' && id) userId = id;
    } catch { /* invalid or expired: treat as anonymous */ }
  }
  req.rateLimitUserId = userId;
  return userId;
};
export const accountOrIpKey = (req) => {
  const userId = verifiedUserId(req);
  return userId ? `api-user:${digest(userId)}` : rateLimitKey('api')(req);
};

export const createLimiter = ({ kind, field, max, windowMs = 15 * 60 * 1000, keyGenerator }) => rateLimit({
  windowMs, max, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: keyGenerator || rateLimitKey(kind, field),
  // Render checks this route repeatedly from a shared IP. Throttling it makes
  // Render mark a healthy API instance as failed and return 502 to every app.
  ...(kind === 'api' ? { skip: (req) => req.method === 'GET' && req.originalUrl.split('?')[0] === '/api/health' } : {}),
  handler: (req, res) => res.status(429).json({ status: 'error', code: `RATE_LIMIT_${kind.toUpperCase()}`, message: 'Too many requests. Please retry later.', retryAfter: Math.ceil(windowMs / 1000) }),
});

// A single page of the patient portal makes ~10 API calls, so a per-IP budget of 100 locked out
// ordinary use (and everyone sharing a hospital or mobile-carrier IP). Signed-in traffic is budgeted
// per account; anonymous traffic keeps the strict per-IP budget. Login, refresh, reset, MFA and
// invitation routes keep their own tighter limiters below.
export const GLOBAL_LIMITS = { account: 1000, anonymous: 100 };
export const globalLimiter = createLimiter({
  kind: 'api',
  keyGenerator: accountOrIpKey,
  max: (req) => (verifiedUserId(req) ? GLOBAL_LIMITS.account : GLOBAL_LIMITS.anonymous),
});
export const loginLimiter = createLimiter({ kind: 'login', field: 'email', max: 10 });
export const registrationLimiter = createLimiter({ kind: 'registration', field: 'email', max: 5 });
export const resetRequestLimiter = createLimiter({ kind: 'reset-request', field: 'email', max: 5 });
export const verificationRequestLimiter = createLimiter({ kind: 'verification-request', field: 'email', max: 5 });
export const verificationConfirmLimiter = createLimiter({ kind: 'verification-confirm', field: 'token', max: 10 });
export const invitationPreviewLimiter = createLimiter({ kind: 'invitation-preview', field: 'id', max: 10 });
export const invitationAcceptLimiter = createLimiter({ kind: 'invitation-accept', field: 'id', max: 5 });
export const resetConfirmLimiter = createLimiter({ kind: 'reset-confirm', field: 'token', max: 10 });
export const refreshLimiter = createLimiter({ kind: 'refresh', field: 'refreshToken', max: 30 });
export const mfaLimiter = createLimiter({ kind: 'mfa', field: 'challengeToken', max: 10 });
export const sensitiveLimiter = createLimiter({ kind: 'sensitive', max: 20 });

export const rateLimitStoreMode = () => 'memory';
export const warnRateLimitFallback = () => console.warn('[security] Rate limits are process-local: deploy one API instance. Counters reset when this process restarts.');
