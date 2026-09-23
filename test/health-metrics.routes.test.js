import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = { healthMetric: { findMany: vi.fn(), count: vi.fn() } };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/health-metrics/health-metrics.routes.js');
process.env.JWT_SECRET = 'metrics-test-secret';
const userId = '5f95ea6b-15e7-4b29-85be-8189931bf2d6';
const auth = { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` };
const app = express(); app.use(express.json()); app.use('/health-metrics', routes);
beforeEach(() => { vi.clearAllMocks(); prisma.healthMetric.findMany.mockResolvedValue([]); prisma.healthMetric.count.mockResolvedValue(0); });

describe('health metric history routes', () => {
  it('returns stable empty and populated user-scoped score history with filters', async () => {
    const empty = await request(app).get('/health-metrics?page=2&limit=5&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z&minScore=40&maxScore=90&sort=asc').set(auth);
    expect(empty.status).toBe(200); expect(empty.body.data).toMatchObject({ items: [], page: 2, limit: 5, total: 0 });
    expect(prisma.healthMetric.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId, health_score: { gte: 40, lte: 90 } }), orderBy: { recordedAt: 'asc' }, skip: 5, take: 5 }));
    prisma.healthMetric.findMany.mockResolvedValueOnce([{ id: 'metric-1', health_score: 74, recordedAt: '2026-09-11T09:30:00.000Z' }]); prisma.healthMetric.count.mockResolvedValueOnce(1);
    expect((await request(app).get('/health-metrics').set(auth)).body.data).toMatchObject({ total: 1, items: [{ health_score: 74 }] });
  });
  it('rejects invalid ranges and authentication failures', async () => {
    expect((await request(app).get('/health-metrics?minScore=90&maxScore=40').set(auth)).status).toBe(400);
    expect((await request(app).get('/health-metrics?from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z').set(auth)).status).toBe(400);
    expect((await request(app).get('/health-metrics?limit=1000').set(auth)).status).toBe(400);
    expect((await request(app).get('/health-metrics')).status).toBe(401); expect((await request(app).get('/health-metrics').set('Authorization', 'Bearer invalid')).status).toBe(401);
    const expired = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: -1 }); expect((await request(app).get('/health-metrics').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });
  it('does not leak database errors', async () => { prisma.healthMetric.findMany.mockRejectedValueOnce(new Error('db-secret')); const response = await request(app).get('/health-metrics').set(auth); expect(response.status).toBe(500); expect(response.body.message).toBe('Health metrics module temporarily unavailable'); });
});
