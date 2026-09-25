import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Real bcrypt (cost 12) is CPU-bound and times out when the whole suite runs in parallel.
vi.mock('bcryptjs', () => ({ default: { hash: async (value) => `test-password-hash:${value}`, compare: async (value, hash) => hash === `test-password-hash:${value}` } }));

const f = () => vi.fn();
const tx = { user: { findUnique: f(), create: f() }, userRole: { findFirst: f() }, pharmacy: { create: f(), findFirst: f(), findUnique: f(), update: f() }, identityOrganization: { create: f() }, organizationMembership: { create: f() }, membershipRole: { create: f() }, activityLog: { create: f() } };
const prisma = { pharmacy: { findFirst: f(), findMany: f(), count: f() }, $transaction: f() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/pharmacies/pharmacies.routes.js');
process.env.JWT_SECRET = 'pharmacy-test';
const admin = '5f95ea6b-15e7-4b29-85be-8189931bf2d6';
const compliance = '4f95ea6b-15e7-4b29-85be-8189931bf2d6';
const pharmacyId = '3b95ea6b-15e7-4b29-85be-8189931bf2d6';
const auth = (id, expiresIn) => ({ Authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET, expiresIn ? { expiresIn } : undefined)}` });
const registration = { email: 'admin@pharmacy.test', password: 'StrongPassword1', fullName: 'Pharmacy Admin', phoneNumber: '+2348012345678', name: 'Sabi Pharmacy', address: '1 Health Street', country: 'Nigeria', state: 'Lagos', city: 'Ikeja', contactEmail: 'contact@pharmacy.test', contactPhone: '+2348098765432' };
const app = express(); app.use(express.json()); app.use('/pharmacies', routes);

beforeEach(() => {
  vi.clearAllMocks(); prisma.$transaction.mockImplementation((callback) => callback(tx));
  tx.user.findUnique.mockResolvedValue(null); tx.user.create.mockResolvedValue({ id: admin }); tx.userRole.findFirst.mockResolvedValue({ id: 'role' });
  tx.pharmacy.create.mockResolvedValue({ id: pharmacyId, complianceStatus: 'PENDING' }); tx.pharmacy.findFirst.mockResolvedValue({ id: pharmacyId, adminUserId: admin, complianceStatus: 'PENDING' }); tx.pharmacy.findUnique.mockResolvedValue({ id: pharmacyId, adminUserId: admin, complianceStatus: 'PENDING' }); tx.pharmacy.update.mockResolvedValue({ id: pharmacyId, complianceStatus: 'VERIFIED' }); tx.activityLog.create.mockResolvedValue({});
  tx.identityOrganization.create.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' });
  tx.organizationMembership.create.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222' });
  tx.membershipRole.create.mockResolvedValue({});
  prisma.pharmacy.findFirst.mockResolvedValue(null); prisma.pharmacy.findMany.mockResolvedValue([]); prisma.pharmacy.count.mockResolvedValue(0);
});

describe('pharmacy onboarding and compliance', () => {
  it('registers only a pending pharmacy-admin account and rejects role/status injection', async () => {
    expect((await request(app).post('/pharmacies/register').send(registration)).status).toBe(201);
    expect(tx.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ roles: { create: { role: 'PHARMACY_ADMIN' } } }) }));
    expect((await request(app).post('/pharmacies/register').send({ ...registration, complianceStatus: 'VERIFIED' })).status).toBe(400);
    expect((await request(app).post('/pharmacies/register').send({ ...registration, role: 'PHARMACY_COMPLIANCE_ADMIN' })).status).toBe(400);
  });
  it('keeps my pharmacy scoped to its pharmacy admin and exposes only verified pharmacies publicly', async () => {
    expect((await request(app).get('/pharmacies/mine').set(auth(admin))).status).toBe(200);
    expect(tx.pharmacy.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { adminUserId: admin } }));
    expect((await request(app).get('/pharmacies?page=1&limit=5&state=Lagos')).status).toBe(200);
    expect(prisma.pharmacy.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ complianceStatus: 'VERIFIED' }), take: 5 }));
    expect((await request(app).get(`/pharmacies/${pharmacyId}`)).status).toBe(404);
  });
  it('allows only a compliance admin to approve and records safe decision state', async () => {
    expect((await request(app).post(`/pharmacies/compliance/${pharmacyId}/decision`).set(auth(compliance)).send({ status: 'VERIFIED', note: 'Reviewed' })).status).toBe(200);
    expect(tx.pharmacy.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ complianceStatus: 'VERIFIED', decidedByUserId: compliance }) }));
    expect((await request(app).get('/pharmacies/compliance').set(auth(compliance))).status).toBe(200);
  });
  it('denies non-compliance users, self approval, cross-pharmacy access, and invalid transitions', async () => {
    tx.userRole.findFirst.mockResolvedValue(null);
    expect((await request(app).post(`/pharmacies/compliance/${pharmacyId}/decision`).set(auth(admin)).send({ status: 'VERIFIED' })).status).toBe(404);
    tx.userRole.findFirst.mockResolvedValue({ id: 'role' }); tx.pharmacy.findUnique.mockResolvedValue({ id: pharmacyId, adminUserId: compliance, complianceStatus: 'PENDING' });
    expect((await request(app).post(`/pharmacies/compliance/${pharmacyId}/decision`).set(auth(compliance)).send({ status: 'VERIFIED' })).status).toBe(404);
    tx.pharmacy.findUnique.mockResolvedValue({ id: pharmacyId, adminUserId: admin, complianceStatus: 'VERIFIED' });
    expect((await request(app).post(`/pharmacies/compliance/${pharmacyId}/decision`).set(auth(compliance)).send({ status: 'REJECTED' })).status).toBe(409);
    tx.pharmacy.findFirst.mockResolvedValue(null);
    expect((await request(app).get('/pharmacies/mine').set(auth('6f95ea6b-15e7-4b29-85be-8189931bf2d6'))).status).toBe(404);
  });
  it('rejects malformed input/tokens and safely handles database failures', async () => {
    expect((await request(app).post('/pharmacies/register').send({ ...registration, contactPhone: 'bad' })).status).toBe(400);
    expect((await request(app).post('/pharmacies/compliance/bad/decision').set(auth(compliance)).send({ status: 'VERIFIED' })).status).toBe(400);
    expect((await request(app).get('/pharmacies/mine')).status).toBe(401);
    expect((await request(app).get('/pharmacies/mine').set('Authorization', 'Bearer bad')).status).toBe(401);
    expect((await request(app).get('/pharmacies/mine').set(auth(admin, '-1s'))).status).toBe(401);
    prisma.pharmacy.findMany.mockRejectedValueOnce(new Error('db-secret'));
    const response = await request(app).get('/pharmacies');
    expect(response.status).toBe(500); expect(response.body.message).toBe('Pharmacy module temporarily unavailable'); expect(JSON.stringify(response.body)).not.toContain('db-secret');
  });
});
