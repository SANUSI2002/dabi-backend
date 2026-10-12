import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';
import prisma from '../../config/db.js';
import { PRIVATE_BUCKETS, assertPrivateBucket, privateStorageClient, uploadPrivateObject } from '../../config/privateStorage.js';
import { scanWithCloudmersive } from '../platform/platform.cloudmersive.js';
import { scanFailureCode, scanRetryAt, isTerminalScanFailure } from '../platform/platform.evidence-scanner.js';
import { audit } from './medical-documents.repository.js';
import { documentHash, intakeConfigured, intakeMaxBytes } from './medical-documents.intake.js';

const bucket = PRIVATE_BUCKETS.clinicalDocuments;
export async function processPatientDocument({ db = prisma, client, scan = scanWithCloudmersive, now = new Date(), configured = intakeConfigured } = {}) {
  if (!configured()) return false;
  client ||= privateStorageClient();
  const rows = await db.medicalDocument.findMany({ where: { uploadBackend: 'supabase', status: 'PENDING_SCAN', scanAttempts: { lt: 5 }, OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }] }, orderBy: [{ scanRequestedAt: 'asc' }, { id: 'asc' }], take: 10 });
  for (const doc of rows) {
    const lease = randomUUID();
    const claimed = await db.medicalDocument.updateMany({ where: { id: doc.id, status: 'PENDING_SCAN', scanAttempts: doc.scanAttempts, OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }] }, data: { scanLeaseToken: lease, scanLeaseExpiresAt: new Date(now.getTime() + 300000), scanAttempts: { increment: 1 } } });
    if (!claimed.count) continue;
    let result, cleanPath;
    try {
      await assertPrivateBucket(client, bucket);
      if (!doc.objectKey.startsWith('quarantine/') || doc.byteSize > intakeMaxBytes()) throw new Error('EVIDENCE_BYTES_INVALID');
      const downloaded = await client.storage.from(bucket).download(doc.objectKey);
      if (downloaded.error || !downloaded.data || downloaded.data.size !== doc.byteSize) throw new Error('EVIDENCE_DOWNLOAD_FAILED');
      const bytes = Buffer.from(await downloaded.data.arrayBuffer());
      if (documentHash(bytes) !== doc.sha256) throw new Error('EVIDENCE_INTEGRITY_MISMATCH');
      result = await scan(bytes, { contentType: doc.declaredContentType });
      if (!['CLEAN', 'INFECTED', 'REJECTED'].includes(result.verdict) || !result.scannerVersion) throw new Error('EVIDENCE_SCAN_UNCERTAIN');
      if (result.verdict === 'CLEAN') {
        const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[doc.declaredContentType];
        cleanPath = `clean/${doc.id}/${lease}.${extension}`;
        await uploadPrivateObject(client, { bucket, path: cleanPath, bytes, contentType: doc.declaredContentType });
      }
      const committed = await db.$transaction(async (tx) => {
        const changed = await tx.medicalDocument.updateMany({ where: { id: doc.id, status: 'PENDING_SCAN', scanLeaseToken: lease }, data: {
          status: result.verdict === 'CLEAN' && doc.kind === 'EXTERNAL_PRESCRIPTION' ? 'PENDING_CLINICAL_REVIEW' : result.verdict,
          scanVerdict: result.verdict, validatedContentType: doc.declaredContentType, scannedAt: new Date(),
          scanErrorCode: null, scanLeaseToken: null, scanLeaseExpiresAt: null,
          storageCleanupPending: true, cleanupObjectKeys: { push: doc.objectKey },
          ...(cleanPath ? { objectKey: cleanPath } : {}),
        } });
        if (changed.count) await audit(tx, doc.ownerPatientId, 'DOCUMENT_SCAN_VERDICT_RECORDED', doc.id);
        return changed.count === 1;
      });
      if (!committed && cleanPath) await db.medicalDocument.updateMany({ where: { id: doc.id }, data: { storageCleanupPending: true, cleanupObjectKeys: { push: cleanPath } } });
    } catch (error) {
      if (cleanPath) await db.medicalDocument.updateMany({ where: { id: doc.id, objectKey: { not: cleanPath } }, data: { storageCleanupPending: true, cleanupObjectKeys: { push: cleanPath } } });
      const code = scanFailureCode(error);
      const terminal = isTerminalScanFailure(code, doc.scanAttempts + 1);
      await db.medicalDocument.updateMany({ where: { id: doc.id, status: 'PENDING_SCAN', scanLeaseToken: lease }, data: { scanLeaseToken: null, scanErrorCode: code, scanLeaseExpiresAt: terminal ? null : scanRetryAt(doc.scanAttempts + 1), ...(terminal ? { scanAttempts: 5 } : {}) } });
    }
    return true;
  }
  return false;
}

export async function cleanDeletedPatientDocuments({ db = prisma, client } = {}) {
  client ||= privateStorageClient();
  await assertPrivateBucket(client, bucket);
  const docs = await db.medicalDocument.findMany({ where: { uploadBackend: 'supabase', storageCleanupPending: true }, take: 20 });
  for (const doc of docs) {
    const paths = [...new Set(doc.cleanupObjectKeys)];
    if (!paths.length) continue;
    const removed = await client.storage.from(bucket).remove(paths);
    // A concurrent deletion may add the current clean object. Never erase that new cleanup job.
    if (!removed.error) await db.medicalDocument.updateMany({ where: { id: doc.id, storageCleanupPending: true, cleanupObjectKeys: { equals: doc.cleanupObjectKeys } }, data: { storageCleanupPending: false, cleanupObjectKeys: [] } });
  }
  return docs.length;
}
export function startPatientDocumentWorker() {
  if (process.env.PATIENT_DOCUMENT_WORKER_ENABLED === 'false') return () => {};
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !intakeConfigured()) return;
    busy = true;
    try { await processPatientDocument(); await cleanDeletedPatientDocuments(); }
    catch { console.error('[patient-documents] Processing unavailable; private files remain queued.'); }
    finally { busy = false; }
  }, 15000);
  timer.unref?.();
  return () => clearInterval(timer);
}
