import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = () => vi.fn();
const tx = { professionalProfile: { findFirst: f() }, doctorCareRelationship: { findFirst: f() }, prescription: { create: f(), findFirst: f(), update: f(), updateMany: f() }, activityLog: { create: f() } };
const prisma = { prescription: { findFirst: f(), findMany: f(), count: f() }, $transaction: f() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/prescriptions/prescriptions.routes.js');
process.env.JWT_SECRET = 'prescription-test';
const patient = '5f95ea6b-15e7-4b29-85be-8189931bf2d6';
const otherPatient = '6f95ea6b-15e7-4b29-85be-8189931bf2d6';
const doctorUser = '4f95ea6b-15e7-4b29-85be-8189931bf2d6';
const otherDoctor = '7f95ea6b-15e7-4b29-85be-8189931bf2d6';
const doctorProfile = '4b95ea6b-15e7-4b29-85be-8189931bf2d6';
const prescriptionId = '3b95ea6b-15e7-4b29-85be-8189931bf2d6';
const auth = (id, expiresIn) => ({ Authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET, expiresIn ? { expiresIn } : undefined)}` });
const body = { patientId: patient, instructions: 'Take with water', items: [{ medicationName: 'Amoxicillin', dosage: '500 mg', frequency: 'TWICE_DAILY', route: 'ORAL', duration: '7 days', quantity: 14, indication: 'Bacterial infection' }] };
const app = express(); app.use(express.json()); app.use('/prescriptions', routes);

beforeEach(() => {
  vi.clearAllMocks(); prisma.$transaction.mockImplementation((callback) => callback(tx));
  tx.professionalProfile.findFirst.mockResolvedValue({ id: doctorProfile }); tx.doctorCareRelationship.findFirst.mockResolvedValue({ id: 'care' });
  tx.prescription.create.mockResolvedValue({ id: prescriptionId, status: 'DRAFT' }); tx.prescription.findFirst.mockResolvedValue({ id: prescriptionId, patientId: patient, status: 'DRAFT' }); tx.prescription.update.mockResolvedValue({ id: prescriptionId, status: 'DRAFT' }); tx.prescription.updateMany.mockResolvedValue({ count: 1 }); tx.activityLog.create.mockResolvedValue({});
  prisma.prescription.findFirst.mockResolvedValue(null); prisma.prescription.findMany.mockResolvedValue([]); prisma.prescription.count.mockResolvedValue(0);
});

describe('doctor-issued prescriptions', () => {
  it('lets a verified doctor with active care create, edit, and issue a draft', async () => {
    expect((await request(app).post('/prescriptions').set(auth(doctorUser)).send(body)).status).toBe(201);
    expect(tx.prescription.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ patientId: patient, doctorProfileId: doctorProfile }) }));
    expect((await request(app).put(`/prescriptions/${prescriptionId}`).set(auth(doctorUser)).send({ items: body.items, instructions: 'Updated' })).status).toBe(200);
    expect((await request(app).post(`/prescriptions/${prescriptionId}/issue`).set(auth(doctorUser)).send({})).status).toBe(200);
    expect(tx.doctorCareRelationship.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ patientId: patient, doctorProfileId: doctorProfile, status: 'ACTIVE' }) }));
  });
  it('scopes patient issued reads and doctor-owned reads and lists', async () => {
    prisma.prescription.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: prescriptionId, patientId: patient, status: 'ISSUED' });
    expect((await request(app).get(`/prescriptions/${prescriptionId}`).set(auth(patient))).status).toBe(200);
    expect((await request(app).get('/prescriptions/patient?page=1&limit=5').set(auth(patient))).status).toBe(200);
    expect(prisma.prescription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { patientId: patient, status: 'ISSUED' }, orderBy: { issuedAt: 'desc' }, take: 5 }));
    prisma.prescription.findFirst.mockResolvedValueOnce({ id: prescriptionId, doctorProfileId: doctorProfile, status: 'DRAFT' });
    expect((await request(app).get(`/prescriptions/${prescriptionId}`).set(auth(doctorUser))).status).toBe(200);
    expect((await request(app).get('/prescriptions/issued').set(auth(doctorUser))).status).toBe(200);
    expect(prisma.prescription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { doctorProfile: { userId: doctorUser } } }));
  });
  it('hides drafts and foreign prescriptions from patients and other doctors', async () => {
    expect((await request(app).get(`/prescriptions/${prescriptionId}`).set(auth(otherPatient))).status).toBe(404);
    tx.professionalProfile.findFirst.mockResolvedValue(null);
    expect((await request(app).put(`/prescriptions/${prescriptionId}`).set(auth(otherDoctor)).send({ items: body.items })).status).toBe(404);
    tx.prescription.updateMany.mockResolvedValue({ count: 0 });
    expect((await request(app).delete(`/prescriptions/${prescriptionId}`).set(auth(otherDoctor))).status).toBe(404);
  });
  it('denies unverified, non-doctor, inactive, revoked, and expired relationship paths', async () => {
    tx.professionalProfile.findFirst.mockResolvedValue(null);
    expect((await request(app).post('/prescriptions').set(auth(doctorUser)).send(body)).status).toBe(404);
    tx.professionalProfile.findFirst.mockResolvedValue({ id: doctorProfile }); tx.doctorCareRelationship.findFirst.mockResolvedValue(null);
    expect((await request(app).post('/prescriptions').set(auth(doctorUser)).send(body)).status).toBe(404);
  });
  it('rejects malformed clinical input, invalid ids, invalid transitions, tokens, and safe database failures', async () => {
    expect((await request(app).post('/prescriptions').set(auth(doctorUser)).send({ ...body, items: [] })).status).toBe(400);
    expect((await request(app).post('/prescriptions').set(auth(doctorUser)).send({ ...body, items: [{ ...body.items[0], route: 'INVALID' }] })).status).toBe(400);
    expect((await request(app).post('/prescriptions/bad/issue').set(auth(doctorUser))).status).toBe(400);
    expect((await request(app).post(`/prescriptions/${prescriptionId}/issue`).set(auth(doctorUser)).send({ status: 'ISSUED' })).status).toBe(400);
    tx.prescription.findFirst.mockResolvedValue(null);
    expect((await request(app).post(`/prescriptions/${prescriptionId}/issue`).set(auth(doctorUser))).status).toBe(404);
    expect((await request(app).get('/prescriptions/patient')).status).toBe(401);
    expect((await request(app).get('/prescriptions/patient').set('Authorization', 'Bearer invalid')).status).toBe(401);
    expect((await request(app).get('/prescriptions/patient').set(auth(patient, '-1s'))).status).toBe(401);
    prisma.prescription.findMany.mockRejectedValueOnce(new Error('db-secret'));
    const response = await request(app).get('/prescriptions/patient').set(auth(patient));
    expect(response.status).toBe(500); expect(response.body.message).toBe('Prescription module temporarily unavailable'); expect(JSON.stringify(response.body)).not.toContain('db-secret');
  });
});
