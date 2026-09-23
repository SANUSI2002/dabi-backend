import { beforeEach, describe, expect, it, vi } from 'vitest';

const activeSession = vi.fn();
const hasActiveMfa = vi.fn();
vi.mock('../src/modules/auth/auth.session.js', () => ({ activeSession }));
vi.mock('../src/modules/auth/auth.mfa.js', () => ({ hasActiveMfa }));
const { requireRecentMfa, requireRecentMfaIfEnrolled } = await import('../src/middleware/mfaMiddleware.js');
const req = { user: { id: 'user-1', sessionId: 'session-1' } };
const response = () => { const res = { statusCode: 200, body: null }; res.status = (value) => { res.statusCode = value; return res; }; res.json = (body) => { res.body = body; return res; }; return res; };

beforeEach(() => vi.clearAllMocks());

describe('recent MFA policy', () => {
  it('requires enrollment and recent verification for privileged operations', async () => {
    const next = vi.fn(); const missing = response();
    hasActiveMfa.mockResolvedValueOnce(false);
    await requireRecentMfa(req, missing, next);
    expect(missing.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    hasActiveMfa.mockResolvedValueOnce(true);
    activeSession.mockResolvedValueOnce({ mfaVerifiedAt: new Date(Date.now() - 11 * 60_000) });
    const stale = response(); await requireRecentMfa(req, stale, next);
    expect(stale.body.error.code).toBe('MFA_REQUIRED');
    hasActiveMfa.mockResolvedValueOnce(true);
    activeSession.mockResolvedValueOnce({ mfaVerifiedAt: new Date() });
    await requireRecentMfa(req, response(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not demand enrollment for ordinary profile changes', async () => {
    hasActiveMfa.mockResolvedValue(false);
    const next = vi.fn();
    await requireRecentMfaIfEnrolled(req, response(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});
