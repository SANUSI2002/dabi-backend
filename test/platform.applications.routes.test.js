import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const id = '33333333-3333-4333-8333-333333333333';
const packageId = '22222222-2222-4222-8222-222222222222';
const db = {
  platformPackage: { findUnique: vi.fn() },
  platformApplication: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  identityOrganization: { create: vi.fn() },
};
vi.mock('../src/config/db.js', () => ({ default: db }));
const { publicApplicationRoutes } = await import('../src/modules/platform/platform.applications.routes.js');
const app = express();
app.use(express.json());
app.use('/api/v1/applications', publicApplicationRoutes);
const payload = {
  clientDraftId: 'app_test_draft_123',
  owner: { firstName: 'Ada', lastName: 'Test', workEmail: 'ada@example.com', phone: '+2348000000000', termsAccepted: true, privacyAccepted: true },
  organization: { legalName: 'Hospital Limited', tradingName: 'Hospital A', facilityType: 'Private Hospital', ownershipType: 'Private', country: 'Nigeria', state: 'Lagos', lga: 'Ikeja', city: 'Lagos', address: 'One Test Road', website: '', officialEmail: 'hospital@example.com', officialPhone: '+2348000000001' },
  corporate: { registrationNumber: 'RC-123', registeredLegalName: 'Hospital Limited', registrationType: 'Company', taxIdentificationNumber: '', incorporationDate: '' },
  regulatoryRegistration: { registrationStatus: 'EXISTING', regulatorId: 'reg-hefamaa', registrationNumber: 'LIC-123', dateIssued: '', expiryDate: '', currentStatus: 'Active', facilityCategory: 'Hospital' },
  operatingOfficer: { fullName: 'Dr Test', role: 'Medical Director', profession: 'Medical Practitioner', regulatorId: 'reg-mdcn', registrationNumber: 'MDCN-123', practisingLicenceNumber: 'PL-123', licenceExpiryDate: '2028-01-01', email: 'doctor@example.com', phone: '+2348000000002' },
  facility: { facilities: 1, branches: 0, beds: 10, staff: 20, doctors: 3, nurses: 7, monthlyPatients: 100, openingHours: '08:00 - 18:00', services: ['Emergency'] },
  selectedProducts: ['emr'], packageId, billingCycle: 'Monthly',
};
const previousFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.RESEND_API_KEY = 'test-key';
  process.env.PASSWORD_RESET_EMAIL_FROM = 'no-reply@sabihealth.org';
  process.env.CLIENT_URL = 'https://sabihealth.org';
  globalThis.fetch = vi.fn(async () => ({ ok: true }));
  db.platformApplication.findUnique.mockResolvedValue(null);
  db.platformApplication.create.mockImplementation(async ({ data }) => ({ id, status: 'AWAITING_EMAIL', createdAt: new Date(), submittedAt: null, ...data }));
  db.platformPackage.findUnique.mockResolvedValue({ id: packageId, active: true, publishedVersion: 1, versions: [{ id: 'v1', version: 1, status: 'PUBLISHED' }] });
});
afterEach(() => { globalThis.fetch = previousFetch; });

describe('hospital application submission', () => {
  it('requires a published package, sends email and does not create a tenant', async () => {
    const response = await request(app).post('/api/v1/applications').send(payload);
    expect(response.status).toBe(202);
    expect(response.body.data.status).toBe('AWAITING_EMAIL');
    expect(response.body.data).not.toHaveProperty('verificationTokenHash');
    expect(db.identityOrganization.create).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).text).toContain(`https://sabihealth.org/register/organization/verify/${id}#`);
    expect(db.platformApplication.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ packageVersionId: 'v1' }) }));
  });

  it('rejects an unpublished package and invalid submitted facts', async () => {
    db.platformPackage.findUnique.mockResolvedValue({ id: packageId, active: true, publishedVersion: null, versions: [] });
    expect((await request(app).post('/api/v1/applications').send(payload)).status).toBe(409);
    expect((await request(app).post('/api/v1/applications').send({ ...payload, facility: { ...payload.facility, staff: 2 } })).status).toBe(400);
    expect(db.platformApplication.create).not.toHaveBeenCalled();
  });

  it('consumes one valid email token before entering review', async () => {
    db.platformApplication.updateMany.mockResolvedValue({ count: 1 });
    db.platformApplication.findUnique.mockResolvedValue({ id, reference: 'SABI-APP-2026-ABCDE', status: 'SUBMITTED', createdAt: new Date(), submittedAt: new Date() });
    const response = await request(app).post(`/api/v1/applications/${id}/verify`).send({ token: 'a'.repeat(64) });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('SUBMITTED');
    expect(db.platformApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'AWAITING_EMAIL' }), data: expect.objectContaining({ status: 'SUBMITTED', verificationTokenHash: null }) }));
  });

  it('sends a replacement only to the unverified application owner', async () => {
    db.platformApplication.findUnique.mockResolvedValue({ ownerEmail: payload.owner.workEmail, status: 'AWAITING_EMAIL', verificationTokenHash: 'old-hash', verificationExpiresAt: new Date() });
    db.platformApplication.updateMany.mockResolvedValue({ count: 1 });
    const response = await request(app).post(`/api/v1/applications/${id}/verification-link`).send({ email: payload.owner.workEmail });
    expect(response.status).toBe(202);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).text).toContain(`https://sabihealth.org/register/organization/verify/${id}#`);
    expect(db.platformApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerEmail: payload.owner.workEmail, status: 'AWAITING_EMAIL' }) }));
    expect(response.body).not.toHaveProperty('data');
  });

  it('does not reveal or email a verified application or the wrong owner', async () => {
    db.platformApplication.findUnique.mockResolvedValue({ ownerEmail: payload.owner.workEmail, status: 'SUBMITTED' });
    const verified = await request(app).post(`/api/v1/applications/${id}/verification-link`).send({ email: payload.owner.workEmail });
    db.platformApplication.findUnique.mockResolvedValue({ ownerEmail: payload.owner.workEmail, status: 'AWAITING_EMAIL' });
    const wrongOwner = await request(app).post(`/api/v1/applications/${id}/verification-link`).send({ email: 'other@example.com' });
    expect(verified.status).toBe(202);
    expect(wrongOwner.body).toEqual(verified.body);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.platformApplication.updateMany).not.toHaveBeenCalled();
  });

  it('does not send when the replacement is cooling down', async () => {
    db.platformApplication.findUnique.mockResolvedValue({ ownerEmail: payload.owner.workEmail, status: 'AWAITING_EMAIL' });
    db.platformApplication.updateMany.mockResolvedValue({ count: 0 });
    expect((await request(app).post(`/api/v1/applications/${id}/verification-link`).send({ email: payload.owner.workEmail })).status).toBe(202);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('restores the previous token if the mail provider rejects a replacement', async () => {
    const oldExpiry = new Date('2026-09-25T00:00:00Z');
    db.platformApplication.findUnique.mockResolvedValue({ ownerEmail: payload.owner.workEmail, status: 'AWAITING_EMAIL', verificationTokenHash: 'old-hash', verificationExpiresAt: oldExpiry });
    db.platformApplication.updateMany.mockResolvedValue({ count: 1 });
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const response = await request(app).post(`/api/v1/applications/${id}/verification-link`).send({ email: payload.owner.workEmail });
    expect(response.status).toBe(202);
    expect(db.platformApplication.updateMany).toHaveBeenCalledTimes(2);
    expect(db.platformApplication.updateMany.mock.calls[1][0].data).toEqual({ verificationTokenHash: 'old-hash', verificationExpiresAt: oldExpiry });
  });
});
