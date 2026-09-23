import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fn = () => vi.fn();
const tx = { vital: { create: fn() }, activityLog: { create: fn() } };
const prisma = { vital: { findMany: fn(), count: fn() }, $transaction: fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/vitals/vitals.routes.js');
process.env.JWT_SECRET = 'vitals-test-secret';
const userId = '5f95ea6b-15e7-4b29-85be-8189931bf2d6';
const auth = { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` };
const app = express(); app.use(express.json()); app.use('/vitals', routes);
const entry = { type: 'HEART_RATE', value: 72, unit: 'bpm', status: 'UNSPECIFIED', recordedAt: '2026-09-11T09:30:00.000Z' };

beforeEach(() => { vi.clearAllMocks(); prisma.$transaction.mockImplementation((work) => work(tx)); prisma.vital.findMany.mockResolvedValue([]); prisma.vital.count.mockResolvedValue(0); tx.vital.create.mockResolvedValue({ id: userId, ...entry, value: '72' }); tx.activityLog.create.mockResolvedValue({}); });

describe('vitals routes', () => {
  it('returns predictable owner-scoped empty, filtered, paginated history', async () => {
    const response = await request(app).get('/vitals?page=2&limit=5&type=HEART_RATE&status=NORMAL&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z&sort=asc').set(auth);
    expect(response.status).toBe(200); expect(response.body.data).toMatchObject({ items: [], page: 2, limit: 5, total: 0 });
    expect(prisma.vital.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId, type: 'HEART_RATE', status: 'NORMAL' }), orderBy: { recordedAt: 'asc' }, skip: 5, take: 5 }));
  });
  it('returns populated history and creates a valid manual entry without changing health score', async () => {
    prisma.vital.findMany.mockResolvedValue([{ id: 'vital-1', ...entry, value: '72' }]); prisma.vital.count.mockResolvedValue(1);
    expect((await request(app).get('/vitals').set(auth)).body.data).toMatchObject({ total: 1, items: [{ id: 'vital-1', type: 'HEART_RATE' }] });
    const response = await request(app).post('/vitals').set(auth).send(entry);
    expect(response.status).toBe(201); expect(tx.vital.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId, type: 'HEART_RATE', value: '72' }) }));
    expect(tx.activityLog.create).toHaveBeenCalledWith({ data: { userId, type: 'VITAL_RECORDED', description: 'Vital entry recorded', meta: { vitalId: userId, vitalType: 'HEART_RATE' } } });
    expect(JSON.stringify(tx.activityLog.create.mock.calls)).not.toContain('72');
  });
  it('allows only compatible units and bounded, precise valid values', async () => {
    expect((await request(app).post('/vitals').set(auth).send({ ...entry, type: 'BLOOD_PRESSURE', unit: 'mmHg', value: '120/80' })).status).toBe(201);
    expect((await request(app).post('/vitals').set(auth).send({ ...entry, type: 'TEMPERATURE', unit: 'F', value: '98.6' })).status).toBe(201);
    expect((await request(app).post('/vitals').set(auth).send({ ...entry, unit: 'mmHg' })).status).toBe(400);
    expect((await request(app).post('/vitals').set(auth).send({ ...entry, value: '72.123' })).status).toBe(400);
    expect((await request(app).post('/vitals').set(auth).send({ ...entry, value: 999 })).status).toBe(400);
    expect((await request(app).post('/vitals').set(auth).send({ ...entry, recordedAt: 'tomorrow' })).status).toBe(400);
  });
  it('rejects invalid filters, reversed date ranges, missing and invalid tokens', async () => {
    expect((await request(app).get('/vitals?type=WEIGHT').set(auth)).status).toBe(400);
    expect((await request(app).get('/vitals?from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z').set(auth)).status).toBe(400);
    expect((await request(app).get('/vitals')).status).toBe(401); expect((await request(app).get('/vitals').set('Authorization', 'Bearer invalid')).status).toBe(401);
    const expired = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: -1 }); expect((await request(app).get('/vitals').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });
  it('does not leak database errors', async () => { prisma.vital.findMany.mockRejectedValueOnce(new Error('db-secret')); const response = await request(app).get('/vitals').set(auth); expect(response.status).toBe(500); expect(response.body.message).toBe('Vitals module temporarily unavailable'); });
});
