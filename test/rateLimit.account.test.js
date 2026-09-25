import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

process.env.JWT_SECRET = 'account-limit-secret';
process.env.RATE_LIMIT_KEY_SECRET = 'account-limit-key';
const { GLOBAL_LIMITS, globalLimiter } = await import('../src/middleware/rateLimitMiddleware.js');

const app = express();
app.set('trust proxy', 1);
app.use('/api/', globalLimiter);
app.get('/api/thing', (_req, res) => res.json({ ok: true }));
const bearer = (sub, secret = process.env.JWT_SECRET) => `Bearer ${jwt.sign({ sub }, secret, { algorithm: 'HS256' })}`;
const hit = (ip, authorization) => {
  const req = request(app).get('/api/thing').set('X-Forwarded-For', ip);
  return authorization ? req.set('Authorization', authorization) : req;
};

describe('global API limiter', () => {
  it('budgets signed-in users per account, so a busy shared IP does not lock them out', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < GLOBAL_LIMITS.anonymous; i += 1) expect((await hit(ip)).status).toBe(200);
    expect((await hit(ip)).status).toBe(429);
    // Same IP, but verified accounts have their own budgets.
    expect((await hit(ip, bearer('patient-a'))).status).toBe(200);
    expect((await hit(ip, bearer('patient-b'))).status).toBe(200);
    // A token that is not signed by us is anonymous and stays on the exhausted IP budget.
    expect((await hit(ip, bearer('patient-c', 'forged-secret'))).status).toBe(429);
    expect((await hit(ip, 'Bearer not-a-jwt')).status).toBe(429);
  });

  it('still caps a single account', async () => {
    const token = bearer('heavy-user');
    let status = 200;
    for (let i = 0; i <= GLOBAL_LIMITS.account && status === 200; i += 1) status = (await hit(`203.0.113.${i % 250}`, token)).status;
    expect(status).toBe(429);
  }, 30000);
});
