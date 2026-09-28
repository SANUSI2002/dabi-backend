// Per-tenant rate limit: one organization exhausting its budget never throttles another.
//
// SCALING NOTE (docs/emr-backend.md, B2): the default store is in-process memory, so with N API
// instances the effective limit is N × the budget. Before running more than one instance, plug in
// a shared store (e.g. Redis INCR + EXPIRE) via setTenantRateLimitStore — the interface is
// `hit(key, windowMs) → Promise<number>` returning the count in the current window.
import { EmrError } from './errors.js';

const memoryStore = () => {
  const windows = new Map();
  return {
    async hit(key, windowMs) {
      const now = Date.now();
      const current = windows.get(key);
      if (!current || current.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        if (windows.size > 50_000) for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
        return 1;
      }
      current.count += 1;
      return current.count;
    },
    reset() { windows.clear(); },
  };
};

let store = memoryStore();
export const setTenantRateLimitStore = (next) => { store = next; };
export const resetTenantRateLimits = () => store.reset?.();

const budget = () => Number(process.env.EMR_TENANT_RATE_LIMIT_PER_MINUTE) || 3000;

export const tenantRateLimit = async (req, res, next) => {
  try {
    const organizationId = req.emr?.organizationId;
    if (!organizationId) return next();
    const windowMs = 60_000;
    const count = await store.hit(`emr:tenant:${organizationId}`, windowMs);
    const limit = budget();
    res.set('RateLimit-Policy', `${limit};w=60`);
    if (count > limit) return next(new EmrError('RATE_LIMITED', { headers: { 'Retry-After': '60' } }));
    return next();
  } catch {
    // A broken limiter store must not take the EMR down; fail open and log.
    return next();
  }
};
