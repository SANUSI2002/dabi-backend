import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fn = () => vi.fn();
const tx = { medication: { create: fn(), updateMany: fn(), findFirst: fn(), deleteMany: fn() }, activityLog: { create: fn() } };
const prisma = { medication: { findMany: fn(), count: fn(), findFirst: fn() }, $transaction: fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/medications/medications.routes.js');
process.env.JWT_SECRET = 'medications-test-secret';
const userId = '5f95ea6b-15e7-4b29-85be-8189931bf2d6'; const otherId = '4b95ea6b-15e7-4b29-85be-8189931bf2d6';
const auth = { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` };
const app = express(); app.use(express.json()); app.use('/medications', routes);
const payload = { name: 'Vitamin D', instructions: 'Daily', time: '09:30' };

beforeEach(() => { vi.clearAllMocks(); prisma.$transaction.mockImplementation((work) => work(tx)); prisma.medication.findMany.mockResolvedValue([]); prisma.medication.count.mockResolvedValue(0); prisma.medication.findFirst.mockResolvedValue(null); tx.medication.create.mockResolvedValue({ id: userId, ...payload, isTaken: false }); tx.medication.updateMany.mockResolvedValue({ count: 1 }); tx.medication.findFirst.mockResolvedValue({ id: userId, ...payload, isTaken: true }); tx.medication.deleteMany.mockResolvedValue({ count: 1 }); tx.activityLog.create.mockResolvedValue({}); });

describe('medications routes', () => {
  it('returns owner-scoped empty list states with filters and pagination', async () => {
    const response = await request(app).get('/medications?page=2&limit=5&adherence=pending&search=vit&sort=desc').set(auth);
    expect(response.status).toBe(200); expect(response.body.data).toMatchObject({ items: [], page: 2, limit: 5, total: 0 });
    expect(prisma.medication.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId, isTaken: false, name: { contains: 'vit', mode: 'insensitive' } }, orderBy: { time: 'desc' }, skip: 5, take: 5 }));
  });
  it('creates, updates, and idempotently records medication adherence', async () => {
    expect((await request(app).post('/medications').set(auth).send(payload)).status).toBe(201);
    expect((await request(app).put(`/medications/${userId}`).set(auth).send({ time: '10:00' })).status).toBe(200);
    tx.medication.findFirst.mockReset().mockResolvedValueOnce({ id: userId, ...payload, isTaken: false }).mockResolvedValueOnce({ id: userId, ...payload, isTaken: true }).mockResolvedValueOnce({ id: userId, ...payload, isTaken: true });
    tx.medication.updateMany.mockClear(); tx.activityLog.create.mockClear();
    expect((await request(app).patch(`/medications/${userId}/taken`).set(auth).send({ isTaken: true })).status).toBe(200);
    expect((await request(app).patch(`/medications/${userId}/taken`).set(auth).send({ isTaken: true })).status).toBe(200);
    expect(tx.medication.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.medication.updateMany).toHaveBeenLastCalledWith({ where: { id: userId, userId }, data: { isTaken: true } });
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1);
    expect(tx.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId, type: 'MEDICATION_ADHERENCE_UPDATED', meta: { medicationId: userId } }) }));
  });
  it('uses identical 404s for missing and cross-user resources', async () => {
    prisma.medication.findFirst.mockResolvedValueOnce(null);
    const missing = await request(app).get(`/medications/${userId}`).set(auth);
    tx.medication.findFirst.mockResolvedValue(null); tx.medication.deleteMany.mockResolvedValue({ count: 0 });
    const crossUpdate = await request(app).patch(`/medications/${otherId}/taken`).set(auth).send({ isTaken: false });
    const crossDelete = await request(app).delete(`/medications/${otherId}`).set(auth);
    expect([missing.body, crossUpdate.body, crossDelete.body]).toEqual([{ status: 'error', message: 'Medication not found' }, { status: 'error', message: 'Medication not found' }, { status: 'error', message: 'Medication not found' }]);
  });
  it('rejects invalid payloads, UUIDs, filters and tokens', async () => {
    expect((await request(app).post('/medications').set(auth).send({ ...payload, time: '25:00', extra: true })).status).toBe(400);
    expect((await request(app).patch('/medications/not-uuid/taken').set(auth).send({ isTaken: 'yes' })).status).toBe(400);
    expect((await request(app).get('/medications?adherence=unknown').set(auth)).status).toBe(400);
    expect((await request(app).get('/medications')).status).toBe(401); expect((await request(app).get('/medications').set('Authorization', 'Bearer invalid')).status).toBe(401);
    const expired = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: -1 }); expect((await request(app).get('/medications').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });
  it('returns a module-safe database failure', async () => { prisma.medication.findMany.mockRejectedValueOnce(new Error('db-password')); const response = await request(app).get('/medications').set(auth); expect(response.status).toBe(500); expect(response.body.message).toBe('Medications module temporarily unavailable'); });
});
