import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const activeSession = vi.fn();
vi.mock('../src/modules/auth/auth.session.js', () => ({ activeSession }));
const { protect } = await import('../src/middleware/authMiddleware.js');

const SECRET = 'auth-middleware-test-secret';
const app = express();
app.get('/private', protect, (req, res) => res.json({ user: req.user }));
const sign = (claims, options = {}) => jwt.sign({ userId: 'user-1', tokenUse: 'access', sid: 'session-1', ...claims }, SECRET, { issuer: 'sabi-identity', audience: 'sabi-api', ...options });
const get = (token) => request(app).get('/private').set('Authorization', `Bearer ${token}`);

describe('protect', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    process.env.NODE_ENV = 'production';
    activeSession.mockReset();
  });
  afterEach(() => { process.env = { ...env }; });

  it('accepts a valid access token with a live session', async () => {
    activeSession.mockResolvedValue({ id: 'session-1' });
    const response = await get(sign({}));
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: 'user-1', sessionId: 'session-1' });
  });

  it('answers 401 for a revoked or expired session', async () => {
    activeSession.mockResolvedValue(null);
    expect((await get(sign({}))).status).toBe(401);
  });

  it('answers 503, not 401, when the session store is unreachable', async () => {
    activeSession.mockRejectedValue(new Error('connection terminated'));
    const response = await get(sign({}));
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('AUTH_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('connection terminated');
  });

  it.each([
    ['an unsigned alg:none token', () => jwt.sign({ userId: 'user-1', tokenUse: 'access', sid: 'session-1', iss: 'sabi-identity', aud: 'sabi-api' }, null, { algorithm: 'none' })],
    ['a token signed with a different HMAC algorithm', () => sign({}, { algorithm: 'HS512' })],
    ['a token for another audience', () => sign({}, { audience: 'other-api' })],
    ['a refresh token', () => sign({ tokenUse: 'refresh' })],
  ])('rejects %s without touching the session store', async (_, token) => {
    expect((await get(token())).status).toBe(401);
    expect(activeSession).not.toHaveBeenCalled();
  });
});
