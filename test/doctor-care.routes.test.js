import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = () => vi.fn();
const tx = { professionalProfile: { findFirst: f() }, userRole: { findFirst: f() }, doctorCareRelationship: { findFirst: f(), create: f(), updateMany: f() }, activityLog: { create: f() } };
const prisma = { professionalProfile: { findMany: f(), count: f(), findFirst: f() }, doctorCareRelationship: { findMany: f() }, $transaction: f() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/doctor-care/doctor-care.routes.js');
process.env.JWT_SECRET = 'doctor-care-test';
const patient = '5f95ea6b-15e7-4b29-85be-8189931bf2d6';
const doctor = '4b95ea6b-15e7-4b29-85be-8189931bf2d6';
const relation = '3b95ea6b-15e7-4b29-85be-8189931bf2d6';
const auth = (id, expiresIn) => ({ Authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET, expiresIn ? { expiresIn } : undefined)}` });
const app = express(); app.use(express.json()); app.use('/doctor-care', routes);

beforeEach(() => {
  vi.clearAllMocks(); prisma.$transaction.mockImplementation((callback) => callback(tx));
  prisma.professionalProfile.findMany.mockResolvedValue([]); prisma.professionalProfile.count.mockResolvedValue(0); prisma.professionalProfile.findFirst.mockResolvedValue(null); prisma.doctorCareRelationship.findMany.mockResolvedValue([]);
  tx.professionalProfile.findFirst.mockResolvedValue({ id: doctor }); tx.userRole.findFirst.mockResolvedValue({ id: 'role' }); tx.doctorCareRelationship.findFirst.mockResolvedValue(null); tx.doctorCareRelationship.create.mockResolvedValue({ id: relation, status: 'PENDING' }); tx.doctorCareRelationship.updateMany.mockResolvedValue({ count: 1 }); tx.activityLog.create.mockResolvedValue({});
});

describe('doctor care', () => {
  it('lists only verified doctors with stable empty state and creates patient-selected consent requests', async () => {
    expect((await request(app).get('/doctor-care/doctors?page=1&limit=5').set(auth(patient))).status).toBe(200);
    expect(prisma.professionalProfile.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ professionType: 'DOCTOR', verificationStatus: 'VERIFIED' }), orderBy: { createdAt: 'asc' }, take: 5 }));
    expect((await request(app).post('/doctor-care/relationships').set(auth(patient)).send({ doctorProfileId: doctor })).status).toBe(201);
    expect(tx.doctorCareRelationship.create).toHaveBeenCalledWith(expect.objectContaining({ data: { patientId: patient, doctorProfileId: doctor } }));
  });
  it('scopes patient and doctor relationship lists and permits valid accept, decline, and revocation transitions', async () => {
    expect((await request(app).get('/doctor-care/relationships/patient').set(auth(patient))).status).toBe(200);
    expect(prisma.doctorCareRelationship.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { patientId: patient } }));
    expect((await request(app).get('/doctor-care/relationships/doctor').set(auth(doctor))).status).toBe(200);
    expect(prisma.doctorCareRelationship.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { doctorProfile: { userId: doctor, professionType: 'DOCTOR', verificationStatus: 'VERIFIED' } } }));
    tx.doctorCareRelationship.findFirst.mockResolvedValue({ id: relation, status: 'ACTIVE' });
    expect((await request(app).post(`/doctor-care/relationships/${relation}/accept`).set(auth(doctor)).send({})).status).toBe(200);
    expect((await request(app).post(`/doctor-care/relationships/${relation}/decline`).set(auth(doctor)).send({})).status).toBe(200);
    expect((await request(app).delete(`/doctor-care/relationships/${relation}`).set(auth(patient))).status).toBe(200);
  });
  it('denies unverified doctors, duplicate or cross-user transitions, and inactive revocation', async () => {
    tx.userRole.findFirst.mockResolvedValueOnce(null);
    expect((await request(app).post('/doctor-care/relationships').set(auth(patient)).send({ doctorProfileId: doctor })).status).toBe(404);
    tx.professionalProfile.findFirst.mockResolvedValueOnce(null);
    expect((await request(app).post('/doctor-care/relationships').set(auth(patient)).send({ doctorProfileId: doctor })).status).toBe(404);
    tx.doctorCareRelationship.findFirst.mockResolvedValue({ id: relation, status: 'PENDING' });
    expect((await request(app).post('/doctor-care/relationships').set(auth(patient)).send({ doctorProfileId: doctor })).status).toBe(409);
    tx.professionalProfile.findFirst.mockResolvedValue(null); tx.doctorCareRelationship.updateMany.mockResolvedValue({ count: 0 });
    expect((await request(app).post(`/doctor-care/relationships/${relation}/accept`).set(auth('1f95ea6b-15e7-4b29-85be-8189931bf2d6')).send({})).status).toBe(404);
    expect((await request(app).delete(`/doctor-care/relationships/${relation}`).set(auth(patient))).status).toBe(404);
  });
  it('rejects invalid ids and tokens and hides database failures', async () => {
    expect((await request(app).post('/doctor-care/relationships').set(auth(patient)).send({ doctorProfileId: 'bad' })).status).toBe(400);
    expect((await request(app).get('/doctor-care/doctors?page=0').set(auth(patient))).status).toBe(400);
    expect((await request(app).get('/doctor-care/doctors')).status).toBe(401);
    expect((await request(app).get('/doctor-care/doctors').set('Authorization', 'Bearer bad')).status).toBe(401);
    expect((await request(app).get('/doctor-care/doctors').set(auth(patient, '-1s'))).status).toBe(401);
    prisma.professionalProfile.findMany.mockRejectedValueOnce(new Error('db-secret'));
    const response = await request(app).get('/doctor-care/doctors').set(auth(patient));
    expect(response.status).toBe(500); expect(response.body.message).toBe('Doctor care module temporarily unavailable'); expect(JSON.stringify(response.body)).not.toContain('db-secret');
  });
});
