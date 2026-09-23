import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fn = () => vi.fn();
const prisma = {
  user: { findUnique: fn() }, userProfile: { findUnique: fn() }, appointment: { findFirst: fn(), count: fn() },
  vital: { findFirst: fn() }, medicalRecord: { findMany: fn(), count: fn() }, medication: { findMany: fn(), count: fn() },
  familyMember: { findMany: fn() }, healthMetric: { findFirst: fn(), findMany: fn() }, notification: { count: fn() },
};
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/dashboard/dashboard.routes.js');
process.env.JWT_SECRET = 'dashboard-route-test-secret';
const userId = '5f95ea6b-15e7-4b29-85be-8189931bf2d6';
const auth = { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` };
const app = express(); app.use(express.json()); app.use('/dashboard', routes);

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(prisma).flatMap(Object.values).forEach((mock) => mock.mockResolvedValue(null));
  prisma.medicalRecord.findMany.mockResolvedValue([]); prisma.medicalRecord.count.mockResolvedValue(0);
  prisma.medication.findMany.mockResolvedValue([]); prisma.medication.count.mockResolvedValue(0);
  prisma.familyMember.findMany.mockResolvedValue([]); prisma.healthMetric.findMany.mockResolvedValue([]);
  prisma.notification.count.mockResolvedValue(0); prisma.appointment.count.mockResolvedValue(0);
});

describe('dashboard routes', () => {
  it('returns a complete empty state to an authenticated user', async () => {
    const response = await request(app).get('/dashboard').set(auth);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ health_metrics: [], notifications: { unread_count: 0 }, medications: { remaining_count: 0, items: [] } });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: userId } }));
  });

  it('returns partial data and a safe records-stat response', async () => {
    prisma.user.findUnique.mockResolvedValue({ full_name: 'Ada Patient', patientId: '#SHM12345' });
    prisma.notification.count.mockResolvedValue(2);
    expect((await request(app).get('/dashboard').set(auth)).body.data).toMatchObject({ user: { full_name: 'Ada Patient' }, notifications: { unread_count: 2 } });
    prisma.medicalRecord.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    prisma.appointment.count.mockResolvedValueOnce(3).mockResolvedValueOnce(4);
    expect((await request(app).get('/dashboard/records-stats').set(auth)).body.data).toEqual({ total_records: 1, total_hospital_visits: 5, total_consultations: 4 });
  });

  it('rejects missing, malformed, and expired JWTs', async () => {
    expect((await request(app).get('/dashboard')).status).toBe(401);
    expect((await request(app).get('/dashboard').set('Authorization', 'Bearer malformed.token')).status).toBe(401);
    const expired = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: -1 });
    expect((await request(app).get('/dashboard').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });

  it('does not leak database errors and has no dashboard mutation routes', async () => {
    prisma.notification.count.mockRejectedValueOnce(new Error('database-password-detail'));
    const failed = await request(app).get('/dashboard').set(auth);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ status: 'error', message: 'Dashboard module temporarily unavailable' });
    expect((await request(app).post('/dashboard/appointments').set(auth)).status).toBe(404);
  });
});
