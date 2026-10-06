import crypto from 'node:crypto';
import prisma from '../../config/db.js';
import { PRIVATE_BUCKETS, privateStorageClient } from '../../config/privateStorage.js';
import { downloadVerified, isTerminalScanFailure, releaseCleanObject, removeQuarantineObject, scanEvidence, scanFailureCode, scanRetryAt } from '../platform/platform.evidence-scanner.js';
import { enabled } from './onboarding.service.js';

// Professional credentials are capped lower than hospital evidence at upload time.
const MAX_CREDENTIAL_BYTES = 5 * 1024 * 1024;

/**
 * Screens one queued professional credential. It shares the download, verification, release,
 * failure-classification and quarantine-cleanup rules with the hospital evidence pipeline
 * (platform.evidence-scanner.js); only the table, lease query and audit trail differ.
 */
export async function processDoctorCredentialJob({ db = prisma, client = privateStorageClient(), scan = scanEvidence } = {}) {
  if (!enabled()) return false;
  const now = new Date();
  const candidates = await db.doctorCredential.findMany({ where: { scanStatus: 'PENDING', OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }], application: { professional: { verificationStatus: { in: ['PENDING', 'REJECTED'] } } } }, include: { application: { select: { professional: { select: { userId: true } } } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 10 });
  for (const doc of candidates) {
    const lease = crypto.randomUUID();
    const claim = await db.doctorCredential.updateMany({ where: { id: doc.id, scanStatus: 'PENDING', OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }] }, data: { scanLeaseToken: lease, scanLeaseExpiresAt: new Date(Date.now() + 300000), scanAttempts: { increment: 1 } } });
    if (!claim.count) continue;
    const attempts = doc.scanAttempts + 1;
    let data;
    try {
      if (attempts > 5) throw new Error('SCAN_LEASE_EXHAUSTED');
      if (doc.storageBucket !== PRIVATE_BUCKETS.hospitalEvidenceQuarantine) throw new Error('EVIDENCE_QUARANTINE_MISMATCH');
      const evidence = { size: doc.byteSize, sha256: doc.sha256, maxBytes: MAX_CREDENTIAL_BYTES };
      const bytes = await downloadVerified(client, doc.storageBucket, doc.storageKey, evidence);
      const result = await scan(bytes, doc);
      if (!['CLEAN', 'INFECTED', 'REJECTED'].includes(result.verdict) || typeof result.scannerVersion !== 'string' || !result.scannerVersion.trim()) throw new Error('EVIDENCE_SCAN_UNCERTAIN');
      data = { scanStatus: result.verdict, scannerVersion: result.scannerVersion.slice(0, 250), scannedAt: new Date(), scanErrorCode: result.verdict === 'REJECTED' ? 'UNSAFE_DOCUMENT_CONTENT' : null };
      if (result.verdict === 'CLEAN') {
        const released = await releaseCleanObject(client, { keyPrefix: `doctor-applications/${doc.applicationId}/${doc.id}`, contentType: doc.contentType, ...evidence }, bytes);
        data.storageBucket = released.bucket; data.storageKey = released.path;
      }
    } catch (error) {
      const code = scanFailureCode(error);
      const terminal = isTerminalScanFailure(code, attempts);
      data = { scanStatus: terminal ? 'FAILED' : 'PENDING', scanErrorCode: code, scanLeaseExpiresAt: terminal ? null : scanRetryAt(attempts) };
    }
    const committed = await db.$transaction(async (tx) => {
      const changed = await tx.doctorCredential.updateMany({ where: { id: doc.id, scanStatus: 'PENDING', scanLeaseToken: lease }, data: { scanLeaseToken: null, scanLeaseExpiresAt: null, ...data } });
      // ActivityLog is account-scoped and requires a real user FK. The actor
      // remains explicitly the system scanner, not the doctor or reviewer.
      if (changed.count) await tx.activityLog.create({ data: { userId: doc.application.professional.userId, type: `DOCTOR_SCAN_${data.scanStatus}`, description: 'Background doctor credential malware screening', meta: { actorKind: 'SYSTEM_SCANNER', credentialId: doc.id, scanStatus: data.scanStatus, code: data.scanErrorCode, provider: process.env.EVIDENCE_SCANNER_PROVIDER || 'clamav' } } });
      return changed.count === 1;
    });
    // Only after the clean location is committed is the quarantine copy redundant. If the lease was
    // lost, the worker that holds it releases to the same deterministic clean path and cleans up.
    if (committed && data.scanStatus === 'CLEAN') await removeQuarantineObject(client, doc.storageBucket, doc.storageKey);
    return true;
  }
  return false;
}
