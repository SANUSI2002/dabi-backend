// Scans finance attachments waiting in quarantine, a few at a time: each is claimed with a lease (so two
// API instances never scan the same file), downloaded, checked against its recorded hash, scanned, and —
// if CLEAN — copied to clean/. INFECTED and REJECTED files are never copied and their quarantined bytes
// are deleted; an uncertain scan is retried later (backing off), up to five attempts. Removed files'
// stored bytes are deleted by the cleanup pass.
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';
import { assertPrivateBucket, privateStorageClient, uploadPrivateObject } from '../../../config/privateStorage.js';
import { scanWithCloudmersive } from '../../platform/platform.cloudmersive.js';
import { scanFailureCode, scanRetryAt, isTerminalScanFailure } from '../../platform/platform.evidence-scanner.js';
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { BUCKET, EXTENSIONS, configured, maxBytes, sha256, withScanner } from './attachments.service.js';

export async function scanFinanceAttachments({ client, scan = scanWithCloudmersive, now = new Date(), isConfigured = configured } = {}) {
  if (!isConfigured()) return 0;
  client ||= privateStorageClient();
  const due = await withScanner((tx) => tx.acctAttachment.findMany({
    where: { status: 'PENDING_SCAN', scanAttempts: { lt: 5 }, OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }] },
    orderBy: [{ scanRequestedAt: 'asc' }, { id: 'asc' }], take: 10,
  }));
  let done = 0;
  for (const a of due) {
    const lease = randomUUID();
    const claimed = await withScanner((tx) => tx.acctAttachment.updateMany({
      where: { id: a.id, status: 'PENDING_SCAN', scanAttempts: a.scanAttempts, OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }] },
      data: { scanLeaseToken: lease, scanLeaseExpiresAt: new Date(now.getTime() + 300_000), scanAttempts: { increment: 1 } },
    }));
    if (!claimed.count) continue;
    let cleanPath;
    try {
      await assertPrivateBucket(client, BUCKET);
      if (!a.objectKey.startsWith('quarantine/') || a.byteSize > maxBytes()) throw new Error('EVIDENCE_BYTES_INVALID');
      const downloaded = await client.storage.from(BUCKET).download(a.objectKey);
      if (downloaded.error || !downloaded.data || downloaded.data.size !== a.byteSize) throw new Error('EVIDENCE_DOWNLOAD_FAILED');
      const bytes = Buffer.from(await downloaded.data.arrayBuffer());
      if (sha256(bytes) !== a.sha256) throw new Error('EVIDENCE_INTEGRITY_MISMATCH');
      const result = await scan(bytes, { contentType: a.contentType });
      if (!['CLEAN', 'INFECTED', 'REJECTED'].includes(result?.verdict) || !result.scannerVersion) throw new Error('EVIDENCE_SCAN_UNCERTAIN');
      if (result.verdict === 'CLEAN') {
        cleanPath = `clean/${a.organizationId}/${a.id}/${lease}.${EXTENSIONS[a.contentType]}`;
        await uploadPrivateObject(client, { bucket: BUCKET, path: cleanPath, bytes, contentType: a.contentType });
      }
      const recorded = await withScanner((tx) => tx.acctAttachment.updateMany({
        where: { id: a.id, status: 'PENDING_SCAN', scanLeaseToken: lease },
        data: {
          status: result.verdict, scannedAt: new Date(), scannerVersion: String(result.scannerVersion).slice(0, 120), scanErrorCode: null, scanLeaseToken: null, scanLeaseExpiresAt: null,
          storageCleanupPending: true, cleanupObjectKeys: { push: a.objectKey }, ...(cleanPath ? { objectKey: cleanPath } : {}),
        },
      }));
      if (recorded.count) {
        await withTenant({ organizationId: a.organizationId }, (tx) => recordAudit(tx, { organizationId: a.organizationId }, { action: `attachment.scan_${result.verdict.toLowerCase()}`, resourceType: `${a.entityType}_attachment`, resourceId: a.id }));
        done += 1;
      } else if (cleanPath) {
        // another worker or a removal won the row: queue this copy for deletion too
        await withScanner((tx) => tx.acctAttachment.updateMany({ where: { id: a.id }, data: { storageCleanupPending: true, cleanupObjectKeys: { push: cleanPath } } }));
      }
    } catch (error) {
      if (cleanPath) await withScanner((tx) => tx.acctAttachment.updateMany({ where: { id: a.id, objectKey: { not: cleanPath } }, data: { storageCleanupPending: true, cleanupObjectKeys: { push: cleanPath } } }));
      const code = scanFailureCode(error);
      const terminal = isTerminalScanFailure(code, a.scanAttempts + 1);
      await withScanner((tx) => tx.acctAttachment.updateMany({
        where: { id: a.id, status: 'PENDING_SCAN', scanLeaseToken: lease },
        data: { scanLeaseToken: null, scanErrorCode: code.slice(0, 60), scanLeaseExpiresAt: terminal ? null : scanRetryAt(a.scanAttempts + 1), ...(terminal ? { scanAttempts: 5 } : {}) },
      }));
    }
  }
  return done;
}

/** Deletes the stored bytes of removed, replaced and failed files. */
export async function cleanFinanceAttachments({ client } = {}) {
  client ||= privateStorageClient();
  await assertPrivateBucket(client, BUCKET);
  const rows = await withScanner((tx) => tx.acctAttachment.findMany({ where: { storageCleanupPending: true }, take: 20 }));
  for (const a of rows) {
    // never delete the clean copy a CLEAN file is still served from
    const paths = [...new Set(a.cleanupObjectKeys)].filter((p) => a.status !== 'CLEAN' || p !== a.objectKey);
    const removed = paths.length ? await client.storage.from(BUCKET).remove(paths) : {};
    if (!removed.error) await withScanner((tx) => tx.acctAttachment.updateMany({ where: { id: a.id, storageCleanupPending: true, cleanupObjectKeys: { equals: a.cleanupObjectKeys } }, data: { storageCleanupPending: false, cleanupObjectKeys: [] } }));
  }
  return rows.length;
}

export function startFinanceAttachmentWorker() {
  if (process.env.FINANCE_DOCUMENT_WORKER_ENABLED === 'false') return () => {};
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !configured()) return;
    busy = true;
    try { await scanFinanceAttachments(); await cleanFinanceAttachments(); }
    catch { console.error('[finance-documents] Scanning unavailable; files stay in quarantine.'); }
    finally { busy = false; }
  }, 15000);
  timer.unref?.();
  return () => clearInterval(timer);
}
