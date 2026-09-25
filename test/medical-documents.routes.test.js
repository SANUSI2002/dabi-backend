import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fn = () => vi.fn();
const adapter = { createUpload: fn(), head: fn(), createDownload: fn(), delete: fn() };
class StorageUnavailableError extends Error { constructor() { super('unavailable'); this.code = 'DOCUMENT_STORAGE_UNAVAILABLE'; } }
vi.mock('../src/modules/medical-documents/medical-documents.storage.js', () => ({
  DOCUMENT_CONTENT_TYPES: ['application/pdf', 'image/jpeg', 'image/png'],
  getUploadMaxBytes: () => Number(process.env.DOCUMENT_UPLOAD_MAX_BYTES || 10485760),
  StorageUnavailableError,
  createDocumentStorage: () => {
    if (process.env.DOCUMENT_STORAGE_PROVIDER !== 'r2') throw new StorageUnavailableError();
    return adapter;
  },
}));

const prisma = {
  userRole: { findFirst: fn() }, medicalRecord: { findFirst: fn() }, medicalDocument: { create: fn(), findFirst: fn(), findMany: fn(), count: fn(), updateMany: fn(), findUnique: fn() },
  activityLog: { create: fn() }, medicalDocumentShare: { create: fn(), findFirst: fn(), findMany: fn(), count: fn(), updateMany: fn() },
  doctorCareRelationship: { findFirst: fn() }, careRelationship: { findFirst: fn() }, medicalDocumentScanResult: { findUnique: fn(), create: fn() },
  user: { findUnique: fn() }, $transaction: fn(),
};
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes, internalDocumentScanRoutes } = await import('../src/modules/medical-documents/medical-documents.routes.js');

const owner = '11111111-1111-4111-8111-111111111111';
const recipient = '22222222-2222-4222-8222-222222222222';
const foreign = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const shareId = '55555555-5555-4555-8555-555555555555';
const recordId = '66666666-6666-4666-8666-666666666666';
const objectKey = 'quarantine/77777777-7777-4777-8777-777777777777';
const secret = 'scanner-test-secret-at-least-32-characters';
const token = (id) => ({ Authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}` });
const app = express(); app.use(express.json()); app.use('/api/v1/medical-documents', routes);
const internal = express(); internal.use('/api/v1/internal/document-scans', internalDocumentScanRoutes);

let db;
const safeDoc = (overrides = {}) => ({ id: documentId, ownerPatientId: owner, objectKey, originalFilename: 'report.pdf', declaredContentType: 'application/pdf', validatedContentType: null, byteSize: 100, kind: 'MEDICAL_RECORD', status: 'PENDING_UPLOAD', medicalRecordId: null, scanVerdict: null, scanRequestedAt: null, scannedAt: null, sha256: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'medical-document-test-secret';
  process.env.DOCUMENT_STORAGE_PROVIDER = 'r2';
  process.env.DOCUMENT_UPLOAD_MAX_BYTES = '10485760';
  process.env.DOCUMENT_SCAN_CALLBACK_SECRET = secret;
  db = { documents: [], shares: [], scans: [], audits: [], eligibleDoctors: new Set(), eligibleCaregivers: new Set() };
  prisma.$transaction.mockImplementation(async (work) => work(prisma));
  prisma.userRole.findFirst.mockImplementation(async ({ where }) => where.userId === owner ? { id: 'role' } : null);
  prisma.medicalRecord.findFirst.mockImplementation(async ({ where }) => where.id === recordId && where.userId === owner ? { id: recordId } : null);
  prisma.medicalDocument.create.mockImplementation(async ({ data }) => { const row = safeDoc({ ...data }); db.documents.push(row); return row; });
  prisma.medicalDocument.findFirst.mockImplementation(async ({ where }) => db.documents.find((row) => row.id === where.id && (!where.ownerPatientId || row.ownerPatientId === where.ownerPatientId) && (!where.status || (typeof where.status === 'string' ? row.status === where.status : row.status !== where.status.not))) || null);
  prisma.medicalDocument.findUnique.mockImplementation(async ({ where }) => db.documents.find((row) => row.id === where.id) || null);
  prisma.medicalDocument.findMany.mockImplementation(async ({ where }) => db.documents.filter((row) => row.ownerPatientId === where.ownerPatientId && row.status !== 'DELETED'));
  prisma.medicalDocument.count.mockImplementation(async ({ where }) => db.documents.filter((row) => row.ownerPatientId === where.ownerPatientId && row.status !== 'DELETED').length);
  prisma.medicalDocument.updateMany.mockImplementation(async ({ where, data }) => { const row = db.documents.find((item) => item.id === where.id && item.ownerPatientId === where.ownerPatientId && item.status === where.status); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; });
  prisma.activityLog.create.mockImplementation(async ({ data }) => { db.audits.push(data); return { id: crypto.randomUUID() }; });
  prisma.doctorCareRelationship.findFirst.mockImplementation(async ({ where }) => db.eligibleDoctors.has(where.doctorProfile.userId) ? { id: 'doctor-care' } : null);
  prisma.careRelationship.findFirst.mockImplementation(async ({ where }) => db.eligibleCaregivers.has(where.caregiverId) ? { id: 'family-care' } : null);
  prisma.medicalDocumentShare.create.mockImplementation(async ({ data }) => { const row = { id: shareId, ...data, createdAt: new Date(), revokedAt: null }; db.shares.push(row); return row; });
  prisma.medicalDocumentShare.findFirst.mockImplementation(async ({ where }) => { const grant = db.shares.find((row) => row.id === where.id && (!where.recipientId || row.recipientId === where.recipientId) && (where.revokedAt !== null || !row.revokedAt) && (!where.expiresAt || row.expiresAt > where.expiresAt.gt)); if (!grant) return null; const doc = db.documents.find((row) => row.id === grant.documentId); if (where.document && (doc.status !== 'CLEAN' || doc.deletedAt)) return null; return where.document ? { document: doc, documentId: grant.documentId } : grant; });
  prisma.medicalDocumentShare.findMany.mockImplementation(async ({ where }) => db.shares.filter((row) => row.recipientId === where.recipientId && !row.revokedAt).map((row) => ({ ...row, document: db.documents.find((doc) => doc.id === row.documentId) })));
  prisma.medicalDocumentShare.count.mockImplementation(async ({ where }) => db.shares.filter((row) => row.recipientId === where.recipientId && !row.revokedAt).length);
  prisma.medicalDocumentShare.updateMany.mockImplementation(async ({ where, data }) => { const rows = db.shares.filter((row) => (!where.id || row.id === where.id) && row.documentId === where.documentId && !row.revokedAt); rows.forEach((row) => Object.assign(row, data)); return { count: rows.length }; });
  prisma.medicalDocumentScanResult.findUnique.mockImplementation(async ({ where }) => db.scans.find((row) => row.replayDigest === where.replayDigest) || null);
  prisma.medicalDocumentScanResult.create.mockImplementation(async ({ data }) => { db.scans.push(data); return { id: crypto.randomUUID() }; });
  prisma.user.findUnique.mockResolvedValue({ patientId: 'SABI-1', full_name: 'Ada Patient', dob: new Date('1990-01-02'), profile: { blood_type: 'O+', known_allergies: 'None', chronic_conditions: 'None', emergencyContactName: 'Kunle', emergencyContactPhone: '+2348000000000', emergencyContactRelation: 'Sibling', emergency_access_permissions: ['Identity'], electronic_health_records: true, consentGiven: true } });
  adapter.createUpload.mockResolvedValue({ method: 'PUT', url: 'https://signed.invalid/upload', expiresInSeconds: 300, headers: { 'Content-Type': 'application/pdf' } });
  adapter.head.mockResolvedValue({ byteSize: 100, contentType: 'application/pdf' });
  adapter.createDownload.mockResolvedValue({ url: 'https://signed.invalid/download', expiresInSeconds: 300 });
  adapter.delete.mockResolvedValue();
});

const uploadBody = { filename: 'report.pdf', contentType: 'application/pdf', byteSize: 100, kind: 'MEDICAL_RECORD' };
const signedScan = (id, body, options = {}) => {
  const raw = JSON.stringify(body); const timestamp = options.timestamp || String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return request(internal).post(`/api/v1/internal/document-scans/${id}`).set('Content-Type', 'application/json').set('X-Document-Scan-Timestamp', timestamp).set('X-Document-Scan-Signature', `sha256=${options.invalid ? '0'.repeat(64) : signature}`).send(raw);
};

describe('secure medical document HTTP lifecycle', () => {
  it('initializes only authenticated patient uploads with opaque keys and minimal audits', async () => {
    expect((await request(app).post('/api/v1/medical-documents/uploads').send(uploadBody)).status).toBe(401);
    const response = await request(app).post('/api/v1/medical-documents/uploads').set(token(owner)).send(uploadBody);
    expect(response.status).toBe(201); expect(response.body.data.upload.url).toContain('signed.invalid');
    expect(response.body.data.document.objectKey).toBeUndefined(); expect(JSON.stringify(response.body.data.document)).not.toContain('signed.invalid');
    const signed = adapter.createUpload.mock.calls[0][0].objectKey;
    expect(signed).toMatch(/^quarantine\/[0-9a-f-]{36}$/); expect(signed).not.toContain('report'); expect(signed).not.toContain(owner);
    expect(db.audits[0].meta).toEqual({ documentId }); expect(db.audits[0].meta).not.toHaveProperty('objectKey');
  });

  it('fails closed without storage configuration and validates upload metadata before signing', async () => {
    delete process.env.DOCUMENT_STORAGE_PROVIDER;
    const unavailable = await request(app).post('/api/v1/medical-documents/uploads').set(token(owner)).send(uploadBody);
    expect(unavailable.status).toBe(503); expect(unavailable.body.code).toBe('DOCUMENT_STORAGE_UNAVAILABLE');
    process.env.DOCUMENT_STORAGE_PROVIDER = 'r2';
    for (const body of [{ ...uploadBody, byteSize: 99999999 }, { ...uploadBody, contentType: 'text/plain' }, { ...uploadBody, filename: '../patient.pdf' }, { ...uploadBody, kind: 'PRESCRIPTION' }]) {
      expect((await request(app).post('/api/v1/medical-documents/uploads').set(token(owner)).send(body)).status).toBe(400);
    }
    expect(adapter.createUpload).not.toHaveBeenCalled();
  });

  it('completes only an owned matching pending upload and rejects invalid objects/states', async () => {
    db.documents.push(safeDoc());
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/complete-upload`).set(token(foreign))).status).toBe(404);
    adapter.head.mockResolvedValueOnce({ byteSize: 101, contentType: 'application/pdf' });
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/complete-upload`).set(token(owner))).status).toBe(409);
    adapter.head.mockResolvedValueOnce({ byteSize: 100, contentType: 'text/plain' });
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/complete-upload`).set(token(owner))).status).toBe(409);
    const ok = await request(app).post(`/api/v1/medical-documents/${documentId}/complete-upload`).set(token(owner));
    expect(ok.status).toBe(200); expect(db.documents[0].status).toBe('PENDING_SCAN');
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/complete-upload`).set(token(owner))).status).toBe(409);
  });

  it('never includes signed URLs in owner list/detail and denies malformed or cross-user requests', async () => {
    db.documents.push(safeDoc({ status: 'CLEAN' }));
    const list = await request(app).get('/api/v1/medical-documents').set(token(owner));
    const detail = await request(app).get(`/api/v1/medical-documents/${documentId}`).set(token(owner));
    expect(JSON.stringify(list.body)).not.toContain('signed.invalid'); expect(JSON.stringify(detail.body)).not.toContain('objectKey');
    expect((await request(app).get(`/api/v1/medical-documents/${documentId}`).set(token(foreign))).status).toBe(404);
    expect((await request(app).get('/api/v1/medical-documents/not-a-uuid').set(token(owner))).status).toBe(400);
    expect((await request(app).get('/api/v1/medical-documents').set('Authorization', 'Bearer expired-or-malformed')).status).toBe(401);
  });

  it('permits downloads only for clean owners or active named recipients and exposes no anonymous path', async () => {
    db.documents.push(safeDoc({ status: 'PENDING_SCAN' }));
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/download`).set(token(owner))).status).toBe(404);
    db.documents[0].status = 'CLEAN';
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/download`).set(token(owner))).body.data.url).toContain('signed.invalid');
    db.shares.push({ id: shareId, documentId, recipientId: recipient, expiresAt: new Date(Date.now() + 60000), revokedAt: null });
    expect((await request(app).post(`/api/v1/medical-documents/shared-with-me/${shareId}/download`).set(token(recipient))).status).toBe(200);
    expect((await request(app).post(`/api/v1/medical-documents/shared-with-me/${shareId}/download`)).status).toBe(401);
    expect((await request(app).get('/api/v1/medical-documents/public/download')).status).toBe(401);
  });

  it('enforces relationship eligibility, recipient scope, expiry and revocation', async () => {
    db.documents.push(safeDoc({ status: 'CLEAN' }));
    const body = { recipientId: recipient, expiresAt: new Date(Date.now() + 60000).toISOString() };
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/shares`).set(token(owner)).send(body)).status).toBe(404);
    db.eligibleCaregivers.add(recipient);
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/shares`).set(token(owner)).send(body)).status).toBe(201);
    expect((await request(app).get('/api/v1/medical-documents/shared-with-me').set(token(recipient))).body.data.total).toBe(1);
    expect((await request(app).get('/api/v1/medical-documents/shared-with-me').set(token(foreign))).body.data.total).toBe(0);
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/shares/${shareId}/revoke`).set(token(owner))).status).toBe(204);
    expect((await request(app).post(`/api/v1/medical-documents/shared-with-me/${shareId}/download`).set(token(recipient))).status).toBe(404);
    expect((await request(app).post(`/api/v1/medical-documents/${documentId}/shares`).set(token(owner)).send({ ...body, expiresAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
  });

  it('rejects unsigned, invalid, stale and replayed scanner callbacks', async () => {
    db.documents.push(safeDoc({ status: 'PENDING_SCAN' }));
    const body = { verdict: 'CLEAN', validatedContentType: 'application/pdf', byteSize: 100, sha256: 'a'.repeat(64), scannerTimestamp: new Date().toISOString() };
    expect((await request(internal).post(`/api/v1/internal/document-scans/${documentId}/result`).set('Content-Type', 'application/json').send(body)).status).toBe(401);
    expect((await signedScan(`${documentId}/result`, body, { invalid: true })).status).toBe(401);
    expect((await signedScan(`${documentId}/result`, body, { timestamp: String(Math.floor(Date.now() / 1000) - 1000) })).status).toBe(401);
    expect((await signedScan(`${documentId}/result`, body)).status).toBe(200);
    expect((await signedScan(`${documentId}/result`, body)).status).toBe(409);
  });

  it.each([['CLEAN', 'CLEAN'], ['INFECTED', 'INFECTED'], ['REJECTED', 'REJECTED']])('atomically records %s only from pending scan', async (verdict, expected) => {
    db.documents.push(safeDoc({ status: 'PENDING_SCAN' }));
    const body = { verdict, validatedContentType: 'application/pdf', byteSize: 100, sha256: 'b'.repeat(64), scannerTimestamp: new Date().toISOString() };
    expect((await signedScan(`${documentId}/result`, body)).status).toBe(200); expect(db.documents[0].status).toBe(expected); expect(db.scans).toHaveLength(1);
    if (verdict === 'CLEAN') expect(adapter.delete).not.toHaveBeenCalled(); else expect(adapter.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps clean external prescriptions pending clinical review', async () => {
    db.documents.push(safeDoc({ status: 'PENDING_SCAN', kind: 'EXTERNAL_PRESCRIPTION' }));
    const body = { verdict: 'CLEAN', validatedContentType: 'application/pdf', byteSize: 100, sha256: 'c'.repeat(64), scannerTimestamp: new Date().toISOString() };
    expect((await signedScan(`${documentId}/result`, body)).body.data.status).toBe('PENDING_CLINICAL_REVIEW');
  });

  it('soft deletes once, revokes access, requests object deletion and keeps audits minimal', async () => {
    db.documents.push(safeDoc({ status: 'CLEAN' })); db.shares.push({ id: shareId, documentId, recipientId: recipient, expiresAt: new Date(Date.now() + 60000), revokedAt: null });
    expect((await request(app).delete(`/api/v1/medical-documents/${documentId}`).set(token(owner))).status).toBe(204);
    expect(adapter.delete).toHaveBeenCalledTimes(1); expect(db.documents[0].status).toBe('DELETED'); expect(db.shares[0].revokedAt).toBeInstanceOf(Date);
    expect((await request(app).delete(`/api/v1/medical-documents/${documentId}`).set(token(owner))).status).toBe(404); expect(adapter.delete).toHaveBeenCalledTimes(1);
    expect(Object.keys(db.audits.at(-1).meta)).toEqual(['documentId']);
  });

  it('returns an owner-only no-store emergency PDF without forbidden record fields', async () => {
    const response = await request(app).get('/api/v1/medical-documents/emergency-summary.pdf').set(token(owner));
    expect(response.status).toBe(200); expect(response.headers['content-type']).toContain('application/pdf'); expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.toString()).toContain('%PDF'); expect(response.body.toString()).not.toContain('diagnosis'); expect(response.body.toString()).not.toContain('notes');
    expect((await request(app).get('/api/v1/medical-documents/emergency-summary.pdf')).status).toBe(401);
  });

  it('returns safe module errors for simulated database and storage failures', async () => {
    prisma.medicalDocument.findMany.mockRejectedValueOnce(new Error('postgres://private-host'));
    const dbFailure = await request(app).get('/api/v1/medical-documents').set(token(owner));
    expect(dbFailure.status).toBe(500); expect(JSON.stringify(dbFailure.body)).not.toContain('private-host');
    db.documents.push(safeDoc({ status: 'CLEAN' })); adapter.createDownload.mockRejectedValueOnce(new Error('secret R2 credential'));
    const storageFailure = await request(app).post(`/api/v1/medical-documents/${documentId}/download`).set(token(owner));
    expect(storageFailure.status).toBe(503); expect(JSON.stringify(storageFailure.body)).not.toContain('credential');
  });
});
