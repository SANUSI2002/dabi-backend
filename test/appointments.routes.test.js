import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fn = () => vi.fn();
const tx = { appointment: { create: fn(), updateMany: fn(), findFirst: fn() }, activityLog: { create: fn() } };
const prisma = { appointment: { findMany: fn(), count: fn(), findFirst: fn() }, $transaction: fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/appointments/appointments.routes.js');
process.env.JWT_SECRET = 'appointments-test-secret';
const userId = '5f95ea6b-15e7-4b29-85be-8189931bf2d6'; const otherId = '4b95ea6b-15e7-4b29-85be-8189931bf2d6';
const auth = { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` };
const app = express(); app.use(express.json()); app.use('/appointments', routes);
const payload = { title: 'Review', doctorName: 'Dr Ada', time: '2026-10-01T09:30:00.000Z', type: 'VIRTUAL' };

beforeEach(() => { vi.clearAllMocks(); prisma.$transaction.mockImplementation((work) => work(tx)); prisma.appointment.findMany.mockResolvedValue([]); prisma.appointment.count.mockResolvedValue(0); prisma.appointment.findFirst.mockResolvedValue(null); tx.appointment.create.mockResolvedValue({ id: userId, ...payload, status: 'SCHEDULED' }); tx.appointment.updateMany.mockResolvedValue({ count: 1 }); tx.appointment.findFirst.mockResolvedValue({ id: userId, ...payload, status: 'SCHEDULED' }); tx.activityLog.create.mockResolvedValue({}); });

describe('appointments routes', () => {
  it('lists stable empty states with validated filtering and pagination', async () => {
    const response = await request(app).get('/appointments?page=2&limit=5&status=SCHEDULED&type=VIRTUAL&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z&sort=desc').set(auth);
    expect(response.status).toBe(200); expect(response.body.data).toMatchObject({ items: [], page: 2, limit: 5, total: 0 });
    expect(prisma.appointment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId, status: 'SCHEDULED', type: 'VIRTUAL' }), orderBy: { time: 'desc' }, skip: 5, take: 5 }));
  });
  it('creates, updates, and cancels only scheduled owned appointments with audit records', async () => {
    expect((await request(app).post('/appointments').set(auth).send(payload)).status).toBe(201);
    expect(tx.appointment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId, type: 'VIRTUAL' }) }));
    expect(tx.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId, type: 'APPOINTMENT_CREATED', meta: expect.not.objectContaining({ title: expect.anything() }) }) }));
    expect((await request(app).patch(`/appointments/${userId}`).set(auth).send({ title: 'Updated' })).status).toBe(200);
    expect((await request(app).delete(`/appointments/${userId}`).set(auth)).status).toBe(200);
    expect(tx.appointment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: userId, userId, status: 'SCHEDULED' }, data: expect.objectContaining({ status: 'CANCELLED' }) }));
  });
  it('uses identical 404s for missing, cross-user, or invalid appointment state', async () => {
    prisma.appointment.findFirst.mockResolvedValueOnce(null);
    const missing = await request(app).get(`/appointments/${userId}`).set(auth);
    tx.appointment.updateMany.mockResolvedValue({ count: 0 });
    const crossUser = await request(app).patch(`/appointments/${otherId}`).set(auth).send({ title: 'Nope' });
    const cancelled = await request(app).delete(`/appointments/${otherId}`).set(auth);
    expect([missing.body, crossUser.body, cancelled.body]).toEqual([{ status: 'error', message: 'Appointment not found' }, { status: 'error', message: 'Appointment not found' }, { status: 'error', message: 'Appointment not found' }]);
    expect(crossUser.status).toBe(404); expect(cancelled.status).toBe(404);
  });
  it('rejects malformed input, dates, UUIDs, invalid transitions and invalid tokens', async () => {
    expect((await request(app).post('/appointments').set(auth).send({ ...payload, type: 'CLINICAL' })).status).toBe(400);
    expect((await request(app).post('/appointments').set(auth).send({ ...payload, time: 'tomorrow' })).status).toBe(400);
    expect((await request(app).patch('/appointments/not-uuid').set(auth).send({ title: 'X' })).status).toBe(400);
    expect((await request(app).get('/appointments?from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z').set(auth)).status).toBe(400);
    expect((await request(app).get('/appointments')).status).toBe(401);
    expect((await request(app).get('/appointments').set('Authorization', 'Bearer invalid')).status).toBe(401);
    const expired = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: -1 }); expect((await request(app).get('/appointments').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });
  it('returns a module-safe database failure', async () => { prisma.appointment.findMany.mockRejectedValueOnce(new Error('db-password')); const response = await request(app).get('/appointments').set(auth); expect(response.status).toBe(500); expect(response.body.message).toBe('Appointments module temporarily unavailable'); });
});
