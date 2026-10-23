import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import prisma from '../../config/db.js';
import { PRIVATE_BUCKETS, assertPrivateBucket, privateStorageClient, privateStorageBackend, privateStorageConfigured, uploadPrivateObject } from '../../config/privateStorage.js';
import { cloudmersiveConfigured } from '../../config/evidenceScanner.js';
import { audit, isPatient, ownedRecord, safeDocumentSelect } from './medical-documents.repository.js';

export const documentError = (code, status = 400) => Object.assign(new Error(code), { code, status });
const bucket = PRIVATE_BUCKETS.clinicalDocuments;
const extensions = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
export const documentHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const intakeMaxBytes = () => {
  const configured = Number(process.env.CLOUDMERSIVE_MAX_FILE_BYTES || 3500000);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 10 * 1024 * 1024 ? configured : 3500000;
};
export function intakeConfigured() {
  return process.env.PATIENT_DOCUMENT_UPLOADS_ENABLED !== 'false'
    && cloudmersiveConfigured() && privateStorageConfigured();
}
export const intakeConfig = () => ({ enabled: intakeConfigured(), maxBytes: intakeMaxBytes(), contentTypes: Object.keys(extensions), scanner: 'Cloudmersive', privacy: 'Documents are stored in private storage. File contents are sent to Cloudmersive for security screening. Only you and eligible people you explicitly share with can open a screened file.' });

export async function receiveDocument(userId, data, bytes, requestKey, { db = prisma, client, configured = intakeConfigured } = {}) {
  if (!configured()) throw documentError('DOCUMENT_INTAKE_UNAVAILABLE', 503);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > intakeMaxBytes()) throw documentError('DOCUMENT_BYTES_INVALID');
  if (!extensions[data.contentType] || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(requestKey || '')) throw documentError('DOCUMENT_BYTES_INVALID');
  client ||= privateStorageClient();
  await assertPrivateBucket(client, bucket);
  const hash = documentHash(bytes), intakeKey = `${userId}:${requestKey}`;
  const document = await db.$transaction(async (tx) => {
    if (!(await isPatient(tx, userId))) throw documentError('RESOURCE_NOT_FOUND', 404);
    if (data.medicalRecordId && !(await ownedRecord(tx, userId, data.medicalRecordId))) throw documentError('RESOURCE_NOT_FOUND', 404);
    // Serialize retries for one owner before checking the unique intake reference.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const prior = await tx.medicalDocument.findUnique({ where: { intakeKey } });
    if (prior) {
      if (prior.sha256 !== hash || prior.kind !== data.kind || prior.declaredContentType !== data.contentType || prior.medicalRecordId !== (data.medicalRecordId || null)) throw documentError('INTAKE_KEY_REUSED', 409);
      if (prior.status === 'DELETED') throw documentError('INVALID_DOCUMENT_STATE', 409);
      return prior;
    }
    const id = randomUUID();
    const created = await tx.medicalDocument.create({ data: {
      id, ownerPatientId: userId, originalFilename: data.filename,
      declaredContentType: data.contentType, byteSize: bytes.length, kind: data.kind,
      medicalRecordId: data.medicalRecordId, uploadBackend: privateStorageBackend(), intakeKey,
      objectKey: `quarantine/${id}.${extensions[data.contentType]}`, sha256: hash,
    } });
    await audit(tx, userId, 'DOCUMENT_UPLOAD_INITIALIZED', id);
    return created;
  });
  if (document.status === 'PENDING_UPLOAD') {
    try {
      await uploadPrivateObject(client, { bucket, path: document.objectKey, bytes, contentType: data.contentType });
    } catch (error) {
      // A timed-out first request can have stored the immutable object. Reuse only identical bytes.
      if (error.code !== 'PRIVATE_STORAGE_UPLOAD_FAILED') throw documentError('DOCUMENT_BYTES_INVALID');
      const existing = await client.storage.from(bucket).download(document.objectKey);
      if (existing.error || !existing.data || existing.data.size !== bytes.length || documentHash(Buffer.from(await existing.data.arrayBuffer())) !== hash) throw documentError('DOCUMENT_STORAGE_ERROR', 503);
    }
    await db.$transaction(async (tx) => {
      const changed = await tx.medicalDocument.updateMany({ where: { id: document.id, ownerPatientId: userId, status: 'PENDING_UPLOAD' }, data: { status: 'PENDING_SCAN', scanRequestedAt: new Date() } });
      if (changed.count) await audit(tx, userId, 'DOCUMENT_UPLOAD_COMPLETED', document.id);
    });
  }
  return db.medicalDocument.findFirst({ where: { id: document.id, ownerPatientId: userId, status: { not: 'DELETED' } }, select: safeDocumentSelect });
}

export async function signedClinicalDocument(item, client = privateStorageClient()) {
  if (item.uploadBackend !== privateStorageBackend() || item.status !== 'CLEAN' || !item.objectKey.startsWith('clean/')) throw documentError('RESOURCE_NOT_FOUND', 404);
  await assertPrivateBucket(client, bucket);
  const { data, error } = await client.storage.from(bucket).createSignedUrl(item.objectKey, 60);
  if (error || !data?.signedUrl) throw documentError('DOCUMENT_STORAGE_ERROR', 503);
  return { url: data.signedUrl, expiresInSeconds: 60 };
}

export async function retryDocumentScan(userId, id, db = prisma) {
  return db.$transaction(async (tx) => {
    const now = new Date();
    const changed = await tx.medicalDocument.updateMany({ where: { id, ownerPatientId: userId, uploadBackend: privateStorageBackend(), status: 'PENDING_SCAN', scanErrorCode: { not: null }, scanLeaseToken: null, OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }] }, data: { scanAttempts: 0, scanErrorCode: null, scanLeaseExpiresAt: null } });
    if (!changed.count) throw documentError('INVALID_DOCUMENT_STATE', 409);
    await audit(tx, userId, 'DOCUMENT_SCAN_RETRY_REQUESTED', id);
    return { id, status: 'PENDING_SCAN' };
  });
}
