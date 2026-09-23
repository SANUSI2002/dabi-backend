import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLimiter } from '../src/middleware/rateLimitMiddleware.js';

describe('API health-check rate limiting', () => {
  it('keeps GET /api/health available when the shared IP has exhausted its API quota', async () => {
    const app = express();
    app.use('/api/', createLimiter({ kind: 'api', max: 1 }));
    app.get('/api/health', (_req, res) => res.json({ status: 'success' }));
    app.get('/api/protected', (_req, res) => res.json({ status: 'success' }));

    expect((await request(app).get('/api/protected')).status).toBe(200);
    expect((await request(app).get('/api/protected')).status).toBe(429);
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/health?probe=1')).status).toBe(200);
    expect((await request(app).post('/api/health')).status).toBe(429);
  });
});
