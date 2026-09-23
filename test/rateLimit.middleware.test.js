import { describe, expect, it, vi } from 'vitest';
process.env.RATE_LIMIT_KEY_SECRET = 'test-rate-limit-secret';
const { rateLimitKey, rateLimitStoreMode, warnRateLimitFallback } = await import('../src/middleware/rateLimitMiddleware.js');
describe('rate-limit keys', () => {
  it('hashes identity and IP without retaining raw values', () => { const key = rateLimitKey('login', 'email')({ ip: '203.0.113.5', body: { email: 'patient@example.test' } }); expect(key).not.toContain('patient@example.test'); expect(key).not.toContain('203.0.113.5'); expect(key).toMatch(/^login:[a-f0-9]{64}:[a-f0-9]{64}$/); });
  it('uses the in-memory store only', () => { expect(rateLimitStoreMode()).toBe('memory'); });
  it('warns safely about single-instance limits', () => { const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); warnRateLimitFallback(); expect(warn).toHaveBeenCalledWith('[security] Rate limits are process-local: deploy one API instance. Counters reset when this process restarts.'); warn.mockRestore(); });
});
