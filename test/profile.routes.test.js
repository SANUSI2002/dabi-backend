import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: { update: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  userProfile: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(async (work) => typeof work === 'function' ? work(prisma) : Promise.all(work)),
  appointment: { deleteMany: vi.fn() }, medication: { deleteMany: vi.fn() }, vital: { deleteMany: vi.fn() }, medicalRecord: { deleteMany: vi.fn() }, category: { deleteMany: vi.fn() }, familyMember: { deleteMany: vi.fn() }, healthMetric: { deleteMany: vi.fn() }, activityLog: { deleteMany: vi.fn() }, notification: { deleteMany: vi.fn() },
};
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: profileRoutes } = await import('../src/modules/profile/profile.routes.js');

process.env.JWT_SECRET = 'profile-test-secret';
const token = (id = '5f95ea6b-15e7-4b29-85be-8189931bf2d6') => jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '1h' });
const app = express(); app.use(express.json()); app.use('/profile', profileRoutes);
const auth = { Authorization: `Bearer ${token()}` };

beforeEach(() => { vi.clearAllMocks(); prisma.userProfile.findUnique.mockResolvedValue({ userId: '5f95ea6b-15e7-4b29-85be-8189931bf2d6' }); prisma.userProfile.upsert.mockResolvedValue({ userId: '5f95ea6b-15e7-4b29-85be-8189931bf2d6' }); prisma.user.update.mockResolvedValue({ id: '5f95ea6b-15e7-4b29-85be-8189931bf2d6' }); });

describe('profile routes', () => {
  it('rejects unauthenticated and malformed bearer access', async () => {
    expect((await request(app).get('/profile')).status).toBe(401);
    expect((await request(app).get('/profile').set('Authorization', 'Bearer malformed')).status).toBe(401);
  });
  it('uses only the authenticated user id for reads and emergency summary', async () => {
    await request(app).get('/profile').set(auth); await request(app).get('/profile/emergency-summary').set(auth);
    expect(prisma.userProfile.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: '5f95ea6b-15e7-4b29-85be-8189931bf2d6' } }));
  });
  it('rejects protected fields, invalid values, and invalid deletion confirmation', async () => {
    for (const body of [{ id: 'x' }, { patientId: 'x' }, { password: 'x' }, { dataSharingConsentAt: 'x' }, { blood_type: 'BAD' }, { dob: 'not-a-date' }, { emergency_access_permissions: ['Money'] }]) expect((await request(app).put('/profile/update').set(auth).send(body)).status).toBe(400);
    expect((await request(app).delete('/profile/delete-account').set(auth).send({ confirmation: 'delete' })).status).toBe(400);
  });
  it('persists allowed consent and emergency-contact fields with timestamps', async () => {
    const response = await request(app).put('/profile/update').set(auth).send({ data_sharing_consent: true, electronic_health_records: false, emergencyContactName: 'Jane Doe', emergencyContactPhone: '+2348012345678', emergencyContactRelation: 'Sibling' });
    expect(response.status).toBe(200);
    expect(prisma.userProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ dataSharingConsentAt: expect.any(Date), electronicHealthRecordsAt: expect.any(Date), emergencyContactName: 'Jane Doe' }) }));
  });
  it('does not allow a boolean toggle to claim an authenticator is enrolled', async () => {
    const response = await request(app).put('/profile/security').set(auth).send({ two_factor_auth: true });
    expect(response.status).toBe(410); expect(prisma.userProfile.upsert).not.toHaveBeenCalled();
  });
  it('returns a safe module response for database failures', async () => {
    prisma.userProfile.findUnique.mockRejectedValueOnce(new Error('database host details'));
    const response = await request(app).get('/profile').set(auth);
    expect(response.status).toBe(500); expect(response.body.message).toBe('Profile module temporarily unavailable');
  });
  it('deletes only the authenticated account through the transaction path', async () => {
    const response = await request(app).delete('/profile/delete-account').set(auth).send({ confirmation: 'DELETE' });
    expect(response.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: '5f95ea6b-15e7-4b29-85be-8189931bf2d6' } });
    expect(prisma.appointment.deleteMany).toHaveBeenCalledWith({ where: { userId: '5f95ea6b-15e7-4b29-85be-8189931bf2d6' } });
  });
  it('returns a safe response when account deletion transaction fails', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('internal transaction topology'));
    const response = await request(app).delete('/profile/delete-account').set(auth).send({ confirmation: 'DELETE' });
    expect(response.status).toBe(500); expect(response.body.message).toBe('Profile module temporarily unavailable');
  });
});
