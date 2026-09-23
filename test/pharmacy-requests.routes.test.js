import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fn = () => vi.fn();
const tx = { userRole: { findFirst: fn() }, pharmacy: { findFirst: fn() }, identityOrganization: { findUnique: fn() }, organizationMembership: { findUnique: fn(), create: fn(), update: fn(), updateMany: fn() }, membershipRole: { upsert: fn() }, pharmacyInventoryItem: { findFirst: fn() }, professionalProfile: { findFirst: fn() }, pharmacyStaffMember: { create: fn(), updateMany: fn(), findFirst: fn() }, prescriptionRequest: { createMany: fn(), findFirst: fn() }, pharmacyQuote: { updateMany: fn(), aggregate: fn(), create: fn() }, activityLog: { create: fn() } };
const prisma = { prescription: { findFirst: fn() }, pharmacy: { findMany: fn() }, prescriptionRequest: { findMany: fn() }, pharmacyQuote: { findMany: fn() }, $transaction: fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/pharmacy-requests/pharmacy-requests.routes.js');
process.env.JWT_SECRET = 'pharmacy-request-test';
const admin = '11111111-1111-4111-8111-111111111111'; const pharmacist = '22222222-2222-4222-8222-222222222222'; const patient = '33333333-3333-4333-8333-333333333333'; const pharmacyId = '44444444-4444-4444-8444-444444444444'; const requestId = '55555555-5555-4555-8555-555555555555'; const prescriptionId = '66666666-6666-4666-8666-666666666666'; const itemId = '77777777-7777-4777-8777-777777777777';
const auth = (id, expiresIn) => ({ Authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET, expiresIn ? { expiresIn } : undefined)}` });
const app = express(); app.use(express.json()); app.use('/requests', routes);
const inventoryItemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const quoteBody = { items: [{ prescriptionItemId: itemId, inventoryItemId, requiredQuantity: 2, availableQuantity: 2, unitPriceMinor: 2500, availabilityStatus: 'AVAILABLE', estimatedFulfilment: 'Tomorrow', pickupAvailable: true, deliveryAvailable: false }] };

beforeEach(() => {
  vi.clearAllMocks(); prisma.$transaction.mockImplementation((cb) => cb(tx));
  tx.userRole.findFirst.mockResolvedValue({ id: 'role' }); tx.pharmacy.findFirst.mockResolvedValue({ id: pharmacyId }); tx.pharmacyInventoryItem.findFirst.mockResolvedValue({ id: inventoryItemId, medicationName: 'Amoxicillin', availableQuantity: 2 }); tx.professionalProfile.findFirst.mockResolvedValue({ id: 'professional' }); tx.pharmacyStaffMember.create.mockResolvedValue({ id: 'staff' }); tx.pharmacyStaffMember.updateMany.mockResolvedValue({ count: 1 }); tx.pharmacyStaffMember.findFirst.mockResolvedValue({ id: 'staff', pharmacyId }); tx.prescriptionRequest.createMany.mockResolvedValue({ count: 2 }); tx.prescriptionRequest.findFirst.mockResolvedValue({ id: requestId, prescription: { items: [{ id: itemId, quantity: 2, medicationName: 'Amoxicillin' }] } }); tx.pharmacyQuote.updateMany.mockResolvedValue({ count: 1 }); tx.pharmacyQuote.aggregate.mockResolvedValue({ _max: { revision: 1 } }); tx.pharmacyQuote.create.mockImplementation(({ data }) => ({ id: 'quote', ...data })); tx.activityLog.create.mockResolvedValue({}); prisma.prescription.findFirst.mockResolvedValue({ id: prescriptionId }); prisma.pharmacy.findMany.mockResolvedValue([{ id: pharmacyId }, { id: '88888888-8888-4888-8888-888888888888' }]); prisma.prescriptionRequest.findMany.mockResolvedValue([]); prisma.pharmacyQuote.findMany.mockResolvedValue([]);
  tx.identityOrganization.findUnique.mockResolvedValue({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  tx.organizationMembership.findUnique.mockResolvedValue(null);
  tx.organizationMembership.create.mockResolvedValue({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'PENDING' });
  tx.organizationMembership.updateMany.mockResolvedValue({ count: 1 });
  tx.membershipRole.upsert.mockResolvedValue({});
});

describe('pharmacy requests and quotes', () => {
  it('requires verified pharmacy-admin ownership to invite a verified pharmacist', async () => {
    expect((await request(app).post('/requests/staff/invite').set(auth(admin)).send({ pharmacistUserId: pharmacist })).status).toBe(201);
    tx.userRole.findFirst.mockResolvedValue(null);
    expect((await request(app).post('/requests/staff/invite').set(auth(admin)).send({ pharmacistUserId: pharmacist })).status).toBe(404);
  });
  it('accepts staff membership and blocks inactive pharmacists', async () => {
    expect((await request(app).post(`/requests/staff/${requestId}/accept`).set(auth(pharmacist)).send({})).status).toBe(200);
    tx.pharmacyStaffMember.findFirst.mockResolvedValue(null);
    expect((await request(app).get('/requests/pharmacy').set(auth(pharmacist))).status).toBe(404);
  });
  it('creates scoped multi-pharmacy requests and rejects duplicates or foreign prescriptions', async () => {
    const body = { prescriptionId, pharmacyIds: [pharmacyId, '88888888-8888-4888-8888-888888888888'] };
    expect((await request(app).post('/requests').set(auth(patient)).send(body)).status).toBe(201);
    tx.prescriptionRequest.createMany.mockResolvedValue({ count: 0 });
    expect((await request(app).post('/requests').set(auth(patient)).send(body)).status).toBe(409);
    prisma.prescription.findFirst.mockResolvedValue(null);
    expect((await request(app).post('/requests').set(auth('99999999-9999-4999-8999-999999999999')).send(body)).status).toBe(404);
  });
  it('calculates quote totals, expires at 24 hours, replaces revisions, and protects routes', async () => {
    const start = Date.now(); const response = await request(app).post(`/requests/${requestId}/quotes`).set(auth(pharmacist)).send(quoteBody);
    expect(response.status).toBe(201); const data = tx.pharmacyQuote.create.mock.calls[0][0].data; expect(data.items.create[0].lineTotalMinor).toBe(5000); expect(data.quoteExpiresAt.getTime()).toBeGreaterThanOrEqual(start + 86400000); expect(tx.pharmacyQuote.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REPLACED' } }));
    expect((await request(app).get('/requests/quotes/patient').set(auth(patient))).status).toBe(200); expect(prisma.pharmacyQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'ISSUED', request: { patientId: patient } }) }));
    expect((await request(app).post(`/requests/${requestId}/quotes`).set(auth(pharmacist)).send({ items: [{ ...quoteBody.items[0], availableQuantity: 3 }] })).status).toBe(409); expect((await request(app).get('/requests/patient')).status).toBe(401); expect((await request(app).get('/requests/patient').set('Authorization', 'Bearer bad')).status).toBe(401); expect((await request(app).get('/requests/patient').set(auth(patient, '-1s'))).status).toBe(401);
  });
  it('denies cross-pharmacy, inactive, unverified, and non-owner staff identities', async () => {
    tx.pharmacyStaffMember.findFirst.mockResolvedValue({ id: 'staff-b', pharmacyId: '88888888-8888-4888-8888-888888888888' });
    tx.prescriptionRequest.findFirst.mockImplementation(({ where }) => where.pharmacyId === pharmacyId ? { id: requestId, prescription: { items: [{ id: itemId, quantity: 2 }] } } : null);
    expect((await request(app).post(`/requests/${requestId}/quotes`).set(auth(pharmacist)).send(quoteBody)).status).toBe(404);
    tx.pharmacyStaffMember.findFirst.mockResolvedValue(null);
    expect((await request(app).get('/requests/pharmacy').set(auth('99999999-9999-4999-8999-999999999999'))).status).toBe(404);
    tx.userRole.findFirst.mockResolvedValue(null);
    expect((await request(app).post('/requests/staff/invite').set(auth(admin)).send({ pharmacistUserId: pharmacist })).status).toBe(404);
    tx.userRole.findFirst.mockResolvedValue({ id: 'role' }); tx.professionalProfile.findFirst.mockResolvedValue(null);
    expect((await request(app).post('/requests/staff/invite').set(auth(admin)).send({ pharmacistUserId: pharmacist })).status).toBe(404);
  });
  it('uses self-scoped request/quote filters and excludes expired or replaced quotes', async () => {
    expect((await request(app).get('/requests/patient').set(auth(patient))).status).toBe(200);
    expect(prisma.prescriptionRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { patientId: patient } }));
    prisma.pharmacyQuote.findMany.mockResolvedValue([{ id: 'current', status: 'ISSUED', quoteExpiresAt: new Date(Date.now() + 1000) }]);
    expect((await request(app).get('/requests/quotes/patient').set(auth(patient))).status).toBe(200);
    expect(prisma.pharmacyQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'ISSUED', quoteExpiresAt: { gt: expect.any(Date) }, request: { patientId: patient } } }));
  });
  it('returns module-safe failures without patient, clinical, or internal details', async () => {
    prisma.prescriptionRequest.findMany.mockRejectedValueOnce(new Error('patient clinical inventory secret'));
    const response = await request(app).get('/requests/patient').set(auth(patient));
    expect(response.status).toBe(500); expect(response.body.message).toBe('Pharmacy requests module temporarily unavailable'); expect(JSON.stringify(response.body)).not.toContain('secret');
  });
  it('marks legacy quotes non-reservable and hides all internal inventory fields from patients', async () => {
    prisma.pharmacyQuote.findMany.mockResolvedValue([{ id: 'legacy', items: [{ inventoryItemId: null, availableQuantity: 9, unitPriceMinor: 4, internalCost: 1 }] }, { id: 'new', items: [{ inventoryItemId, availableQuantity: 2, unitPriceMinor: 5 }] }]);
    const response = await request(app).get('/requests/quotes/patient').set(auth(patient));
    expect(response.status).toBe(200); expect(response.body.data[0].items[0]).toEqual(expect.objectContaining({ reservable: false, reservableReason: 'LEGACY_QUOTE_NOT_RESERVABLE' })); expect(response.body.data[1].items[0]).toEqual(expect.objectContaining({ reservable: true })); expect(JSON.stringify(response.body)).not.toContain('inventoryItemId'); expect(JSON.stringify(response.body)).not.toContain('internalCost');
  });
  it('rejects foreign, inactive, unverified, incompatible, and insufficient inventory references', async () => {
    for (const inventory of [null, { id: inventoryItemId, medicationName: 'Wrong medicine', availableQuantity: 9 }, { id: inventoryItemId, medicationName: 'Amoxicillin', availableQuantity: 1 }]) { tx.pharmacyInventoryItem.findFirst.mockResolvedValue(inventory); expect((await request(app).post(`/requests/${requestId}/quotes`).set(auth(pharmacist)).send(quoteBody)).status).toBe(409); }
  });
});
