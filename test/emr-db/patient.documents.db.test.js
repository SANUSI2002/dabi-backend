import { randomUUID } from 'node:crypto';
import { Blob, Buffer } from 'node:buffer';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, tokenFor } from './fixtures.js';
const objects = new Map();
const client = { storage: {
  getBucket: async () => ({ data: { public: false } }),
  from: (bucket) => ({
    upload: async (path, bytes) => { const key = `${bucket}/${path}`; if (objects.has(key)) return { error: { statusCode: 409 } }; objects.set(key, Buffer.from(bytes)); return { data: { path } }; },
    download: async (path) => objects.has(`${bucket}/${path}`) ? { data: new Blob([objects.get(`${bucket}/${path}`)]) } : { error: {} },
    remove: async (paths) => { paths.forEach((path) => objects.delete(`${bucket}/${path}`)); return {}; },
    createSignedUrl: async () => ({ data: { signedUrl: 'https://synthetic.supabase.co/storage/v1/object/sign/doc?token=synthetic' } }),
  }),
} };
vi.mock('../../src/config/privateStorage.js', async (original) => ({ ...(await original()), privateStorageClient: () => client }));
const { app } = await import('../../src/app.js');
const intake = await import('../../src/modules/medical-documents/medical-documents.intake.js');
const worker = await import('../../src/modules/medical-documents/medical-documents.worker.js');
const service = await import('../../src/modules/medical-documents/medical-documents.service.js');
const bytes = Buffer.from('%PDF-synthetic-no-real-patient-data');
const facts = { filename: 'synthetic.pdf', contentType: 'application/pdf', kind: 'LAB_RESULT' };
const makeUser = async (role = 'PATIENT') => {
  const user = await prisma.user.create({ data: { patientId: randomUUID(), full_name: 'Synthetic Patient', email: `${randomUUID()}@documents.test`, password: 'synthetic-not-a-password', accountStatus: 'ACTIVE', emailVerifiedAt: new Date() } });
  await prisma.userRole.create({ data: { userId: user.id, role } });
  return user;
};
const receive = async (user, overrides = {}) => intake.receiveDocument(user.id, { ...facts, ...overrides }, bytes, randomUUID(), { client, configured: () => true });
const scan = (verdict = 'CLEAN') => worker.processPatientDocument({ client, configured: () => true, scan: async () => ({ verdict, scannerVersion: 'synthetic scanner' }) });
beforeAll(() => {
  process.env.CLOUDMERSIVE_API_KEY = 'synthetic-only'; process.env.CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED = 'true';
  process.env.SUPABASE_URL = 'https://synthetic.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-only';
});
describe('Patient private documents against real PostgreSQL', () => {
  it('receives bounded files automatically, hides storage keys and rejects foreign reads', async () => {
    const owner = await makeUser(), stranger = await makeUser();
    const received = await request(app).post('/api/v1/medical-documents/uploads/receive?kind=LAB_RESULT').set('Authorization', tokenFor(owner.id)).set('Content-Type', 'application/pdf').set('X-Document-Filename', 'synthetic.pdf').set('Idempotency-Key', randomUUID()).send(bytes);
    expect(received.status).toBe(202); expect(received.body.data.status).toBe('PENDING_SCAN');
    expect(received.body.data).not.toHaveProperty('objectKey'); expect(received.body.data).not.toHaveProperty('ownerPatientId');
    const id = received.body.data.id;
    expect((await request(app).post(`/api/v1/medical-documents/${id}/download`).set('Authorization', tokenFor(owner.id))).status).toBe(404);
    expect((await request(app).get(`/api/v1/medical-documents/${id}`).set('Authorization', tokenFor(stranger.id))).status).toBe(404);
    expect((await request(app).get('/api/v1/medical-documents/config')).status).toBe(401);
    await scan();
    const preview = await request(app).post(`/api/v1/medical-documents/${id}/download`).set('Authorization', tokenFor(owner.id));
    expect(preview.status).toBe(200); expect(preview.body.data.expiresInSeconds).toBe(60);
  });
  it('deduplicates upload retries and rejects an idempotency key used for another document', async () => {
    const owner = await makeUser(), key = randomUUID();
    const first = await intake.receiveDocument(owner.id, facts, bytes, key, { client, configured: () => true });
    const again = await intake.receiveDocument(owner.id, facts, bytes, key, { client, configured: () => true });
    expect(again.id).toBe(first.id);
    await expect(intake.receiveDocument(owner.id, { ...facts, kind: 'OTHER' }, bytes, key, { client, configured: () => true })).rejects.toMatchObject({ code: 'INTAKE_KEY_REUSED' });
    expect(await prisma.medicalDocument.count({ where: { ownerPatientId: owner.id } })).toBe(1);
    await scan();
  });
  it('returns an actionable 413 for oversized files without creating an upload record', async () => {
    const owner = await makeUser();
    const result = await request(app).post('/api/v1/medical-documents/uploads/receive?kind=LAB_RESULT').set('Authorization', tokenFor(owner.id)).set('Content-Type', 'application/pdf').set('X-Document-Filename', 'synthetic-too-large.pdf').set('Idempotency-Key', randomUUID()).send(Buffer.alloc(3500001));
    expect(result.status, JSON.stringify(result.body)).toBe(413);
    expect(await prisma.medicalDocument.count({ where: { ownerPatientId: owner.id } })).toBe(0);
  });
  it.each(['INFECTED', 'REJECTED'])('never previews or shares a %s file, and deletes its private bytes', async (verdict) => {
    const owner = await makeUser(), recipient = await makeUser();
    const doc = await receive(owner);
    await scan(verdict); await worker.cleanDeletedPatientDocuments({ client });
    expect((await prisma.medicalDocument.findUnique({ where: { id: doc.id } })).status).toBe(verdict);
    await expect(service.ownerDownload(owner.id, doc.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(service.createShare(owner.id, doc.id, { recipientId: recipient.id, expiresAt: new Date(Date.now() + 86400000).toISOString() })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    const stored = await prisma.medicalDocument.findUnique({ where: { id: doc.id } });
    expect(objects.has(`sabi-clinical-documents/${stored.objectKey}`)).toBe(false);
  });
  it('keeps uncertain scans private, bounds retries, and permits an audited owner retry', async () => {
    const owner = await makeUser(), stranger = await makeUser(), doc = await receive(owner);
    await worker.processPatientDocument({ client, configured: () => true, scan: async () => { throw new Error('CLOUDMERSIVE_UNAVAILABLE'); } });
    const delayed = await prisma.medicalDocument.findUnique({ where: { id: doc.id } });
    expect(delayed.status).toBe('PENDING_SCAN'); expect(delayed.scanErrorCode).toBe('CLOUDMERSIVE_UNAVAILABLE');
    await prisma.medicalDocument.update({ where: { id: doc.id }, data: { scanAttempts: 5, scanLeaseExpiresAt: null } });
    await expect(intake.retryDocumentScan(stranger.id, doc.id)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_STATE' });
    await intake.retryDocumentScan(owner.id, doc.id); await scan();
    expect((await prisma.medicalDocument.findUnique({ where: { id: doc.id } })).status).toBe('CLEAN');
  });
  it('rechecks caregiver permission on every download and treats invitation expiry separately from access expiry', async () => {
    const owner = await makeUser(), caregiver = await makeUser('CAREGIVER'), doc = await receive(owner); await scan();
    const relationship = await prisma.careRelationship.create({ data: { patientId: owner.id, caregiverId: caregiver.id, caregiverEmail: caregiver.email, relationshipType: 'FAMILY', permissions: ['RECORDS'], status: 'ACTIVE', expiresAt: new Date('2020-01-01') } });
    expect((await service.shareRecipients(owner.id)).items).toContainEqual(expect.objectContaining({ id: caregiver.id }));
    const share = await service.createShare(owner.id, doc.id, { recipientId: caregiver.id, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    expect((await service.sharedDownload(caregiver.id, share.id)).expiresInSeconds).toBe(60);
    expect((await service.sharedWithMe(caregiver.id, { page: 1, limit: 12 })).items).toHaveLength(1);
    await prisma.careRelationship.update({ where: { id: relationship.id }, data: { permissions: [] } });
    await expect(service.sharedDownload(caregiver.id, share.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect((await service.sharedWithMe(caregiver.id, { page: 1, limit: 12 })).items).toHaveLength(0);
    await service.revokeShare(owner.id, doc.id, share.id);
    expect((await service.listShares(owner.id, doc.id)).items[0].revokedAt).not.toBeNull();
  });
  it('revokes sharing immediately on deletion and durably removes all object copies', async () => {
    const owner = await makeUser(), doc = await receive(owner); await scan();
    const record = await prisma.medicalDocument.findUnique({ where: { id: doc.id } });
    await service.remove(owner.id, doc.id);
    await expect(service.ownerDownload(owner.id, doc.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await worker.cleanDeletedPatientDocuments({ client });
    expect(objects.has(`sabi-clinical-documents/${record.objectKey}`)).toBe(false);
  });
  it('does not turn an externally uploaded prescription into an issued pharmacy prescription', async () => {
    const owner = await makeUser(), doc = await receive(owner, { kind: 'EXTERNAL_PRESCRIPTION' }); await scan();
    expect((await prisma.medicalDocument.findUnique({ where: { id: doc.id } })).status).toBe('PENDING_CLINICAL_REVIEW');
    expect(await prisma.prescription.count({ where: { patientId: owner.id } })).toBe(0);
  });
});
