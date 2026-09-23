import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const secret = () => process.env.RATE_LIMIT_KEY_SECRET || process.env.JWT_SECRET || 'development-only-rate-limit-key';
const digest = (value) => crypto.createHmac('sha256', secret()).update(String(value || '')).digest('hex');
const ipKey = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
const identity = (req, field) => digest(req.body?.[field] || req.params?.[field] || 'anonymous');
export const rateLimitKey = (kind, field) => (req) => `${kind}:${digest(ipKey(req))}:${field ? identity(req, field) : 'ip'}`;

export const createLimiter = ({ kind, field, max, windowMs = 15 * 60 * 1000 }) => rateLimit({
  windowMs, max, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: rateLimitKey(kind, field),
  handler: (req, res) => res.status(429).json({ status: 'error', code: `RATE_LIMIT_${kind.toUpperCase()}`, message: 'Too many requests. Please retry later.', retryAfter: Math.ceil(windowMs / 1000) }),
});

export const globalLimiter = createLimiter({ kind: 'api', max: 100 });
export const loginLimiter = createLimiter({ kind: 'login', field: 'email', max: 10 });
export const registrationLimiter = createLimiter({ kind: 'registration', field: 'email', max: 5 });
export const resetRequestLimiter = createLimiter({ kind: 'reset-request', field: 'email', max: 5 });
export const resetConfirmLimiter = createLimiter({ kind: 'reset-confirm', field: 'token', max: 10 });
export const refreshLimiter = createLimiter({ kind: 'refresh', field: 'refreshToken', max: 30 });
export const mfaLimiter = createLimiter({ kind: 'mfa', field: 'challengeToken', max: 10 });
export const sensitiveLimiter = createLimiter({ kind: 'sensitive', max: 20 });

export const rateLimitStoreMode = () => 'memory';
export const warnRateLimitFallback = () => console.warn('[security] Rate limits are process-local: deploy one API instance. Counters reset when this process restarts.');
