import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const activeSession = vi.fn();
vi.mock('../src/modules/auth/auth.session.js', () => ({ activeSession }));
const { protect } = await import('../src/middleware/authMiddleware.js');
const { requireTrustedOrigin } = await import('../src/modules/auth/auth.cookie.js');

const response = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};
beforeEach(() => { vi.clearAllMocks(); process.env.JWT_SECRET = 'browser-security-test'; process.env.CLIENT_URLS = 'https://emr.example.test,https://care.example.test'; });

describe('browser session boundaries', () => {
  it('rejects revoked access sessions even when the JWT signature is valid', async () => {
    const token = jwt.sign({ userId: 'user-1', sid: 'session-1', tokenUse: 'access' }, process.env.JWT_SECRET);
    const req = { get: (header) => header === 'authorization' ? `Bearer ${token}` : undefined };
    const next = vi.fn();
    activeSession.mockResolvedValue(null);
    await protect(req, response(), next);
    expect(next).not.toHaveBeenCalled();
    activeSession.mockResolvedValue({ id: 'session-1' });
    await protect(req, response(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user.sessionId).toBe('session-1');
  });

  it('requires an exact allowlisted origin for cookie-authenticated requests', () => {
    const makeRequest = (origin) => ({ get: (header) => ({ origin, cookie: 'sabi-refresh=secret', 'x-sabi-client': 'browser' })[header] });
    const next = vi.fn();
    const blocked = response();
    requireTrustedOrigin(makeRequest('https://evil.example.test'), blocked, next);
    expect(blocked.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    requireTrustedOrigin(makeRequest('https://emr.example.test'), response(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});
