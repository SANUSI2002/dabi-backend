import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import prisma from '../../config/db.js';
import { assertPrivateBucket, PRIVATE_BUCKETS, privateStorageClient } from '../../config/privateStorage.js';
import { scanEvidence } from '../platform/platform.evidence-scanner.js';
import { enabled } from './onboarding.service.js';

export async function processDoctorCredentialJob({ db = prisma, client = privateStorageClient(), scan = scanEvidence } = {}) {
  if (!enabled()) return false;
  const now = new Date();
  const candidates = await db.doctorCredential.findMany({ where: { scanStatus: 'PENDING', OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }], application: { professional: { verificationStatus: { in: ['PENDING', 'REJECTED'] } } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 10 });
  for (const doc of candidates) {
    const lease = crypto.randomUUID();
    const claim = await db.doctorCredential.updateMany({ where: { id: doc.id, scanStatus: 'PENDING', OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }] }, data: { scanLeaseToken: lease, scanLeaseExpiresAt: new Date(Date.now() + 300000), scanAttempts: { increment: 1 } } });
    if (!claim.count) continue;
    const attempts = doc.scanAttempts + 1;
    let data;
    try {
      if (attempts > 5) throw new Error('SCAN_LEASE_EXHAUSTED');
      if (doc.storageBucket !== PRIVATE_BUCKETS.hospitalEvidenceQuarantine) throw new Error('EVIDENCE_QUARANTINE_MISMATCH');
      await assertPrivateBucket(client, doc.storageBucket);
      const download = await client.storage.from(doc.storageBucket).download(doc.storageKey);
      if (download.error || !download.data) throw new Error('EVIDENCE_DOWNLOAD_FAILED');
      const bytes = Buffer.from(await download.data.arrayBuffer());
      if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.length !== doc.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== doc.sha256) throw new Error('EVIDENCE_INTEGRITY_MISMATCH');
      const result = await scan(bytes, doc);
      if (!['CLEAN', 'INFECTED', 'REJECTED'].includes(result.verdict) || typeof result.scannerVersion !== 'string' || !result.scannerVersion.trim()) throw new Error('EVIDENCE_SCAN_UNCERTAIN');
      data = { scanStatus: result.verdict, scannerVersion: result.scannerVersion.slice(0, 250), scannedAt: new Date(), scanErrorCode: result.verdict === 'REJECTED' ? 'UNSAFE_DOCUMENT_CONTENT' : null };
      if (result.verdict === 'CLEAN') {
        await assertPrivateBucket(client, PRIVATE_BUCKETS.hospitalEvidenceClean);
        const extension = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' }[doc.contentType];
        if (!extension) throw new Error('EVIDENCE_CONTENT_TYPE_INVALID');
        const path = `doctor-applications/${doc.applicationId}/${doc.id}.${extension}`;
        const upload = await client.storage.from(PRIVATE_BUCKETS.hospitalEvidenceClean).upload(path, bytes, { contentType: doc.contentType, upsert: false, cacheControl: '0' });
        if (upload.error) {
          const existing = await client.storage.from(PRIVATE_BUCKETS.hospitalEvidenceClean).download(path);
          if (existing.error || !existing.data || crypto.createHash('sha256').update(Buffer.from(await existing.data.arrayBuffer())).digest('hex') !== doc.sha256) throw new Error('EVIDENCE_CLEAN_UPLOAD_FAILED');
        }
        data.storageBucket = PRIVATE_BUCKETS.hospitalEvidenceClean; data.storageKey = path;
      }
    } catch (error) {
      const code = /^[A-Z_]{4,64}$/.test(error.message || '') ? error.message : 'EVIDENCE_SCAN_FAILED';
      const terminal = attempts >= 5 || ['EVIDENCE_INTEGRITY_MISMATCH', 'EVIDENCE_QUARANTINE_MISMATCH', 'CLOUDMERSIVE_FILE_TOO_LARGE', 'CLOUDMERSIVE_FORMAT_MISMATCH'].includes(code);
      data = { scanStatus: terminal ? 'FAILED' : 'PENDING', scanErrorCode: code, scanLeaseExpiresAt: terminal ? null : new Date(Date.now() + Math.min(30, 2 ** attempts) * 60000) };
    }
    await db.$transaction(async (tx) => {
      const changed = await tx.doctorCredential.updateMany({ where: { id: doc.id, scanStatus: 'PENDING', scanLeaseToken: lease }, data: { scanLeaseToken: null, scanLeaseExpiresAt: null, ...data } });
      if (changed.count) await tx.activityLog.create({ data: { userId: null, type: `DOCTOR_SCAN_${data.scanStatus}`, description: 'Doctor credential malware screening', meta: { credentialId: doc.id, scanStatus: data.scanStatus, code: data.scanErrorCode, provider: process.env.EVIDENCE_SCANNER_PROVIDER || 'clamav' } } });
    });
    return true;
  }
  return false;
}
