// Attachments on accounting records: a supplier's invoice on a bill, a remittance advice on an invoice.
//
// Rules enforced here:
//   - a file is a PDF, JPEG or PNG within the size limit, its bytes matching its type; it is stored in the
//     private finance bucket's quarantine/ area and nobody can open it until the scanner says CLEAN, when a
//     clean copy is made under clean/ and opened through a 60-second signed link; INFECTED or REJECTED
//     files are never opened and their bytes are deleted;
//   - it belongs to a record of the organization (a bill or an invoice that exists); re-attaching the
//     same file name to the same record makes the next version; an upload retried with the same
//     Idempotency-Key returns the same attachment (with different bytes it is refused);
//   - acct.view lists and opens files, acct.post attaches and removes them; removing keeps the row (who,
//     when) and queues the stored bytes for deletion;
//   - with no scanner or private storage configured, attaching says so (FINANCE_DOCUMENTS_UNAVAILABLE).
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import prisma from '../../../config/db.js';
import { PRIVATE_BUCKETS, assertPrivateBucket, privateStorageClient, uploadPrivateObject } from '../../../config/privateStorage.js';
import { cloudmersiveConfigured } from '../../../config/evidenceScanner.js';
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { EmrError } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { requireAcct } from '../ledger/ledger.service.js';

export const BUCKET = PRIVATE_BUCKETS.financeDocuments;
export const EXTENSIONS = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
const SIGNATURES = { 'application/pdf': Buffer.from('%PDF-'), 'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]), 'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
const org = (context) => ({ organizationId: context.organizationId });
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const maxBytes = () => {
  const configured = Number(process.env.FINANCE_DOCUMENT_MAX_BYTES || process.env.CLOUDMERSIVE_MAX_FILE_BYTES || 3500000);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 10 * 1024 * 1024 ? configured : 3500000;
};
/** Attachments need the scanner and the private storage; FINANCE_DOCUMENT_UPLOADS_ENABLED=false switches them off. */
export function configured() {
  return process.env.FINANCE_DOCUMENT_UPLOADS_ENABLED !== 'false' && cloudmersiveConfigured()
    && Boolean(process.env.SUPABASE_URL) && Boolean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
}
const unavailable = () => new EmrError('FINANCE_DOCUMENTS_UNAVAILABLE');

const present = (a, names) => ({
  id: a.id, entityType: a.entityType, entityId: a.entityId, entityLabel: a.entityLabel, filename: a.filename, mimeType: a.contentType,
  sizeKb: Math.max(1, Math.round(a.byteSize / 1024)), version: a.version, note: a.note ?? undefined, status: a.status,
  uploadedBy: names.get(a.uploadedByUserId) ?? 'Former member', uploadedAt: a.createdAt.toISOString(),
  ...(a.scanErrorCode && a.status === 'PENDING_SCAN' ? { scanError: true } : {}),
});

/** Every attachment of the organization still on file, newest first, and whether attaching is available. */
export async function listAttachments(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    const rows = await tx.acctAttachment.findMany({ where: { ...org(context), status: { not: 'REMOVED' } }, orderBy: { createdAt: 'desc' }, take: 2000 });
    const names = await userNameMap(tx, rows.map((r) => r.uploadedByUserId));
    return { enabled: configured(), maxBytes: maxBytes(), contentTypes: Object.keys(EXTENSIONS), items: rows.map((r) => present(r, names)) };
  });
}

async function entityOf(tx, context, entityType, entityId) {
  const found = entityType === 'bill'
    ? await tx.acctPurchaseDoc.findFirst({ where: { ...org(context), id: entityId, kind: 'bill' }, select: { id: true } })
    : await tx.acctSalesDoc.findFirst({ where: { ...org(context), id: entityId, kind: 'invoice' }, select: { id: true } });
  if (!found) throw new EmrError('HR_RECORD_NOT_FOUND', { message: `That ${entityType} was not found.` });
}

/** Receives a file for a bill or invoice: checked, stored in quarantine, queued for scanning. */
export async function receiveAttachment(context, input, bytes, contentType, requestKey, { client, isConfigured = configured } = {}) {
  requireAcct(context, 'acct.post');
  if (!isConfigured()) throw unavailable();
  if (!EXTENSIONS[contentType]) throw new EmrError('VALIDATION_FAILED', { message: 'Attach a PDF, JPEG or PNG file.' });
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes()) throw new EmrError('VALIDATION_FAILED', { message: `Attach a file of up to ${Math.floor(maxBytes() / 1024 / 1024 * 10) / 10} MB.` });
  if (!bytes.subarray(0, SIGNATURES[contentType].length).equals(SIGNATURES[contentType])) throw new EmrError('VALIDATION_FAILED', { message: 'The file is not the type it says it is.' });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey || '')) throw new EmrError('IDEMPOTENCY_KEY_REQUIRED');
  client ||= privateStorageClient();
  await assertPrivateBucket(client, BUCKET).catch(() => { throw unavailable(); });
  const hash = sha256(bytes);
  const row = await withTenant(context, async (tx) => {
    await entityOf(tx, context, input.entityType, input.entityId);
    const prior = await tx.acctAttachment.findFirst({ where: { ...org(context), intakeKey: requestKey } });
    if (prior) {
      if (prior.sha256 !== hash || prior.entityId !== input.entityId || prior.contentType !== contentType) throw new EmrError('IDEMPOTENCY_KEY_REUSED');
      return prior;
    }
    const same = await tx.acctAttachment.count({ where: { ...org(context), entityType: input.entityType, entityId: input.entityId, filename: input.filename } });
    const id = randomUUID();
    const created = await tx.acctAttachment.create({
      data: {
        id, ...org(context), entityType: input.entityType, entityId: input.entityId, entityLabel: input.entityLabel, filename: input.filename, contentType,
        byteSize: bytes.length, sha256: hash, note: input.note ?? null, version: same + 1, intakeKey: requestKey,
        objectKey: `quarantine/${context.organizationId}/${id}.${EXTENSIONS[contentType]}`, uploadedByUserId: context.userId,
      },
    });
    await recordAudit(tx, context, { action: 'attachment.received', resourceType: `${input.entityType}_attachment`, resourceId: id, changedFields: [input.filename] });
    return created;
  });
  if (row.status === 'PENDING_UPLOAD') {
    try {
      await uploadPrivateObject(client, { bucket: BUCKET, path: row.objectKey, bytes, contentType });
    } catch (error) {
      // a timed-out first try may already have stored these exact bytes: reuse them only if identical
      const existing = error.code === 'PRIVATE_STORAGE_UPLOAD_FAILED' ? await client.storage.from(BUCKET).download(row.objectKey) : null;
      if (!existing || existing.error || !existing.data || sha256(Buffer.from(await existing.data.arrayBuffer())) !== hash) throw unavailable();
    }
    await withTenant(context, (tx) => tx.acctAttachment.updateMany({ where: { ...org(context), id: row.id, status: 'PENDING_UPLOAD' }, data: { status: 'PENDING_SCAN', scanRequestedAt: new Date() } }));
  }
  return withTenant(context, async (tx) => present(await tx.acctAttachment.findFirst({ where: { ...org(context), id: row.id } }), await userNameMap(tx, [row.uploadedByUserId])));
}

/** A 60-second link to a scanned, clean file. */
export async function downloadAttachment(context, id, { client } = {}) {
  requireAcct(context, 'acct.view');
  const a = await withTenant(context, (tx) => tx.acctAttachment.findFirst({ where: { ...org(context), id } }));
  if (!a || a.status === 'REMOVED') throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Attachment not found.' });
  if (a.status === 'PENDING_SCAN' || a.status === 'PENDING_UPLOAD') throw new EmrError('INVALID_STATE', { message: 'The file is still being checked for viruses. Try again in a minute.' });
  if (a.status !== 'CLEAN' || !a.objectKey.startsWith('clean/')) throw new EmrError('INVALID_STATE', { message: 'This file failed the security check and cannot be opened.' });
  client ||= privateStorageClient();
  await assertPrivateBucket(client, BUCKET).catch(() => { throw unavailable(); });
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(a.objectKey, 60, { download: a.filename });
  if (error || !data?.signedUrl) throw unavailable();
  await withTenant(context, (tx) => recordAudit(tx, context, { action: 'attachment.opened', resourceType: `${a.entityType}_attachment`, resourceId: id }));
  return { url: data.signedUrl, expiresInSeconds: 60, filename: a.filename };
}

/** Takes a file off the record: the row stays (who, when), the stored bytes are queued for deletion. */
export async function removeAttachment(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const a = await tx.acctAttachment.findFirst({ where: { ...org(context), id } });
    if (!a || a.status === 'REMOVED') throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Attachment not found.' });
    await tx.acctAttachment.updateMany({
      where: { ...org(context), id, status: a.status },
      data: { status: 'REMOVED', removedAt: new Date(), removedByUserId: context.userId, storageCleanupPending: true, cleanupObjectKeys: { push: a.objectKey } },
    });
    await recordAudit(tx, context, { action: 'attachment.removed', resourceType: `${a.entityType}_attachment`, resourceId: id, changedFields: [a.filename] });
    return { id, removed: true };
  });
}

// ---- the scan worker ---------------------------------------------------------------------------------
// Rows are read and updated across organizations under the scanner's own system context (its row-security
// clause and column grants allow nothing else); each verdict is audited in its organization's context.
const SCANNER = 'finance-document-scanner';
export async function withScanner(work, { db = prisma } = {}) {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE sabi_emr_app');
    await tx.$executeRaw`SELECT set_config('app.system_context', ${SCANNER}, true)`;
    return work(tx);
  }, { maxWait: 5000, timeout: 15000 });
}
