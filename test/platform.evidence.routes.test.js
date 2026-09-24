import express from 'express';
import { Buffer } from 'node:buffer';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const applicationId = '33333333-3333-4333-8333-333333333333';
const evidenceId = '44444444-4444-4444-8444-444444444444';
const userId = '11111111-1111-4111-8111-111111111111';
const token = 'a'.repeat(64);
const details = { organization: { country: 'Nigeria', state: 'Lagos', facilityType: 'Private Hospital', ownershipType: 'Private' }, regulatoryRegistration: { registrationStatus: 'EXISTING' } };
const db = {
  platformApplication: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  platformApplicationEvidence: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  platformApplicationEvidenceEvent: { create: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(async (callback) => callback(db)),
};
const storage = { storage: { from: vi.fn(() => ({ remove: vi.fn(async () => ({ error: null })) })) } };
const uploadPrivateObject = vi.fn();
const signedEvidencePreview = vi.fn();
const identity = { findIdentity: vi.fn(), findPlatformRoles: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: db }));
vi.mock('../src/config/privateStorage.js', () => ({
  PRIVATE_BUCKETS: { hospitalEvidenceQuarantine: 'sabi-hospital-evidence-quarantine', hospitalEvidenceClean: 'sabi-hospital-evidence-clean' },
  PrivateStorageError: class PrivateStorageError extends Error { constructor(code) { super(code); this.code = code; } },
  privateStorageClient: () => storage,
  uploadPrivateObject,
  signedEvidencePreview,
}));
vi.mock('../src/modules/identity/identity.repository.js', () => identity);
const { evidenceRoutes, platformEvidenceRoutes } = await import('../src/modules/platform/platform.evidence.routes.js');
const { platformApplicationRoutes } = await import('../src/modules/platform/platform.applications.routes.js');

const app = express();
app.use(express.json());
app.use('/api/v1/applications', evidenceRoutes);
app.use('/api/v1/platform/applications', platformApplicationRoutes);
process.env.JWT_SECRET = 'platform-evidence-route-test';
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` });
const uploadPath = `/api/v1/applications/${applicationId}/evidence/OFFICER_LICENCE`;
const evidenceAuth = { 'X-Sabi-Evidence-Token': token };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.HOSPITAL_EVIDENCE_INTAKE_ENABLED = 'true';
  process.env.HOSPITAL_EVIDENCE_REVIEW_ENABLED = 'false';
  process.env.RESEND_API_KEY = 'test-key';
  process.env.PASSWORD_RESET_EMAIL_FROM = 'no-reply@sabihealth.org';
  process.env.CLIENT_URL = 'https://sabihealth.org';
  globalThis.fetch = vi.fn(async () => ({ ok: true }));
  db.$transaction.mockImplementation(async (callback) => callback(db));
  db.platformApplication.findFirst.mockResolvedValue({ id: applicationId, details, status: 'SUBMITTED' });
  db.platformApplication.findUnique.mockResolvedValue({ id: applicationId, ownerEmail: 'owner@example.com', emailVerifiedAt: new Date(), status: 'SUBMITTED' });
  db.platformApplication.updateMany.mockResolvedValue({ count: 1 });
  db.platformApplicationEvidence.findMany.mockResolvedValue([]);
  db.platformApplicationEvidence.updateMany.mockResolvedValue({ count: 1 });
  db.platformApplicationEvidence.create.mockImplementation(async ({ data, select }) => Object.fromEntries(Object.entries({ id: 'evidence-1', ...data, createdAt: new Date() }).filter(([key]) => select[key])));
  db.platformApplicationEvidenceEvent.create.mockResolvedValue({});
  db.activityLog.create.mockResolvedValue({});
  uploadPrivateObject.mockResolvedValue({ bucket: 'sabi-hospital-evidence-quarantine', path: 'applications/test/evidence.pdf' });
  signedEvidencePreview.mockResolvedValue('https://private.example.test/short-lived');
  identity.findIdentity.mockResolvedValue({ id: userId, accountStatus: 'ACTIVE' });
  identity.findPlatformRoles.mockResolvedValue([{ role: { code: 'SABI_PLATFORM_ADMIN', permissions: [{ permissionCode: 'platform.onboarding.review' }] } }]);
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe('email-proven hospital evidence intake', () => {
  it('stays disabled without an explicit test flag', async () => {
    process.env.HOSPITAL_EVIDENCE_INTAKE_ENABLED = 'false';
    const result = await request(app).put(uploadPath).set(evidenceAuth).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.7'));
    expect(result.status).toBe(503);
    expect(uploadPrivateObject).not.toHaveBeenCalled();
  });

  it('requires a scoped, unexpired applicant token', async () => {
    db.platformApplication.findFirst.mockResolvedValue(null);
    const result = await request(app).put(uploadPath).set(evidenceAuth).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.7'));
    expect(result.status).toBe(403);
    expect(db.platformApplication.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: applicationId, evidenceAccessTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/), emailVerifiedAt: { not: null } }) }));
    expect(uploadPrivateObject).not.toHaveBeenCalled();
  });

  it('rejects an inapplicable document requirement', async () => {
    const result = await request(app).put(`/api/v1/applications/${applicationId}/evidence/UNLISTED_DOCUMENT`).set(evidenceAuth).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.7'));
    expect(result.status).toBe(400);
    expect(uploadPrivateObject).not.toHaveBeenCalled();
  });

  it('uploads bounded bytes to quarantine and records an append-only event', async () => {
    const bytes = Buffer.from('%PDF-1.7\nsynthetic-test-only');
    const result = await request(app).put(uploadPath).set(evidenceAuth).set('Content-Type', 'application/pdf').send(bytes);
    expect(result.status).toBe(201);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.data.scanStatus).toBe('PENDING');
    expect(result.body.data.reviewStatus).toBe('PENDING');
    expect(result.body.data).not.toHaveProperty('storageKey');
    expect(uploadPrivateObject).toHaveBeenCalledWith(storage, expect.objectContaining({ bucket: 'sabi-hospital-evidence-quarantine', bytes, contentType: 'application/pdf' }));
    expect(db.platformApplicationEvidenceEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ evidenceId: 'evidence-1', eventType: 'UPLOADED', actorKind: 'EMAIL_VERIFIED_APPLICANT' }) });
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it('provides a non-enumerating, rate-limited link request', async () => {
    const path = `/api/v1/applications/${applicationId}/evidence-access`;
    const wrong = await request(app).post(path).send({ email: 'other@example.com' });
    expect(wrong.status).toBe(202);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const matched = await request(app).post(path).send({ email: 'owner@example.com' });
    expect(matched.status).toBe(202);
    expect(matched.body.message).toBe(wrong.body.message);
    expect(db.platformApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }));
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('requires platform permission and audits reviewer metadata access without preview', async () => {
    const path = `/api/v1/platform/applications/${applicationId}/evidence`;
    expect((await request(app).get(path)).status).toBe(401);
    const result = await request(app).get(path).set(auth());
    expect(result.status).toBe(200);
    expect(result.body.data.previewAvailable).toBe(false);
    expect(db.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'PLATFORM_APPLICATION_EVIDENCE_LISTED', userId }) });
    expect(platformEvidenceRoutes).toBeDefined();
  });

  it('keeps preview and authenticity decisions closed by default', async () => {
    const base = `/api/v1/platform/applications/${applicationId}/evidence/${evidenceId}`;
    expect((await request(app).get(`${base}/preview`).set(auth())).status).toBe(503);
    expect((await request(app).post(`${base}/review`).set(auth()).send({ decision: 'REJECTED', note: 'Not authentic after registry check.' })).status).toBe(503);
    expect(signedEvidencePreview).not.toHaveBeenCalled();
  });

  it('issues a short-lived preview only for clean, authorized evidence and audits access', async () => {
    process.env.HOSPITAL_EVIDENCE_REVIEW_ENABLED = 'true';
    db.platformApplicationEvidence.findFirst.mockResolvedValue({ id: evidenceId, applicationId, scanStatus: 'CLEAN', storageBucket: 'sabi-hospital-evidence-clean', storageKey: 'private/test.pdf' });
    const result = await request(app).get(`/api/v1/platform/applications/${applicationId}/evidence/${evidenceId}/preview`).set(auth());
    expect(result.status).toBe(200);
    expect(result.body.data.expiresInSeconds).toBe(60);
    expect(result.body.data).not.toHaveProperty('storageKey');
    expect(db.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'PLATFORM_APPLICATION_EVIDENCE_PREVIEWED' }) });
  });

  it('records a clean latest-version authenticity decision but does not approve EMR', async () => {
    process.env.HOSPITAL_EVIDENCE_REVIEW_ENABLED = 'true';
    db.platformApplication.findUnique.mockResolvedValue({ status: 'UNDER_REVIEW' });
    db.platformApplicationEvidence.findFirst
      .mockResolvedValueOnce({ id: evidenceId, requirementKey: 'OFFICER_LICENCE', expiresAt: null })
      .mockResolvedValueOnce({ id: evidenceId });
    const result = await request(app).post(`/api/v1/platform/applications/${applicationId}/evidence/${evidenceId}/review`).set(auth())
      .send({ decision: 'VERIFIED', sourceName: 'Test regulator register', reference: 'TEST-123' });
    expect(result.status).toBe(200);
    expect(db.platformApplicationEvidenceEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'AUTHENTICITY_VERIFIED', actorKind: 'PLATFORM_REVIEWER' }) });
    expect(db.platformApplicationEvidence.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reviewStatus: 'VERIFIED' }) }));
  });
});
