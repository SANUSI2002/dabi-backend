import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import prisma from '../../config/db.js';
import { PRIVATE_BUCKETS, assertPrivateBucket, privateStorageClient } from '../../config/privateStorage.js';
import { recordAudit } from '../audit/audit.service.js';
import { ownerDownload } from '../medical-documents/medical-documents.service.js';
import { aiConfig, aiDocumentsAvailable, aiError, AI_DOCUMENT_CONSENT_VERSION } from './ai.config.js';
import { generationAvailable, requireGenerationAvailable } from './ai.policy.js';
import { reserveAiQuota } from './ai.quota.js';
import { extractionVersion, extractAiDocument } from './ai.extraction.js';
import { inspectAiDocument } from './ai.document-inspection.js';
import { requireAiOriginSession } from './ai.auth.js';
import { dispatchAllowance, finishAllowance, settleAllowance, allowanceLock } from './ai.allowances.js';

const missing = () => aiError(404, 'AI_SOURCE_NOT_FOUND', 'This document is not available for Sabi AI.');
const activeUser = async (userId, db = prisma) => {
  if (!await db.user.findFirst({ where: { id: userId, accountStatus: 'ACTIVE', emailVerifiedAt: { not: null } }, select: { id: true } })) throw aiError(403, 'AI_ACCOUNT_UNAVAILABLE', 'A verified, active account is required.');
};
const documentWhere = (ownerUserId) => ({ ownerPatientId: ownerUserId, status: 'CLEAN', scanVerdict: 'CLEAN', deletedAt: null, uploadBackend: 'supabase' });
const audit = (db, userId, action, id) => recordAudit(db, { actorUserId: userId, action, resourceType: 'AI_DOCUMENT_SOURCE', resourceId: id });
const safe = { id: true, documentId: true, state: true, revision: true, errorCode: true, patientLabels: true, createdAt: true, reviewedAt: true, finishedAt: true,
  document: { select: { originalFilename: true, kind: true } } };
async function owned(userId, id, db = prisma) {
  await activeUser(userId, db);
  const source = await db.aiDocumentSource.findFirst({ where: { id, ownerUserId: userId, deletedAt: null, document: documentWhere(userId) } });
  if (!source) throw missing();
  const doc = await db.medicalDocument.findUnique({ where: { id: source.documentId }, select: { sha256: true } });
  if (!doc?.sha256 || source.sourceSha256 !== doc.sha256) throw missing();
  return source;
}
export async function listAiSources(userId) {
  await activeUser(userId);
  const rows = await prisma.aiDocumentSource.findMany({ where: { ownerUserId: userId, deletedAt: null, document: documentWhere(userId) }, select: { ...safe, sourceSha256: true, document: { select: { originalFilename: true, kind: true, sha256: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
  return rows.filter((s) => s.sourceSha256 === s.document.sha256).map((s) => { const result = { ...s, document: { originalFilename: s.document.originalFilename, kind: s.document.kind } }; delete result.sourceSha256; return result; });
}
export async function listAiSourceDocuments(userId) {
  await activeUser(userId);
  return prisma.medicalDocument.findMany({ where: { ownerPatientId: userId, deletedAt: null, status: { not: 'DELETED' }, uploadBackend: 'supabase' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50,
    select: { id: true, originalFilename: true, kind: true, status: true, byteSize: true, createdAt: true } });
}
export async function getAiSource(userId, id) {
  await owned(userId, id);
  const source = await prisma.aiDocumentSource.findUnique({ where: { id }, select: { ...safe, pages: { orderBy: { pageNumber: 'asc' }, select: { pageNumber: true, originalText: true, text: true, uncertain: true, fields: true } } } });
  await audit(prisma, userId, 'AI_SOURCE_VIEWED', id); return source;
}
export async function createAiSource(user, input) {
  if (!aiDocumentsAvailable()) throw aiError(503, 'AI_DOCUMENTS_UNAVAILABLE', 'Document AI processing is not available. Your original file remains in your records.');
  return prisma.$transaction(async (tx) => {
    await allowanceLock(tx);
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`; await activeUser(user.id, tx);
    const prior = await tx.aiDocumentSource.findUnique({ where: { ownerUserId_clientRequestId: { ownerUserId: user.id, clientRequestId: input.clientRequestId } } });
    if (prior) {
      if (prior.documentId !== input.documentId || prior.deletedAt) throw aiError(409, 'AI_IDEMPOTENCY_CONFLICT', 'This request ID was already used.');
      await owned(user.id, prior.id, tx); return tx.aiDocumentSource.findUnique({ where: { id: prior.id }, select: safe });
    }
    const doc = await tx.medicalDocument.findFirst({ where: { id: input.documentId, ...documentWhere(user.id) } });
    if (!doc?.sha256 || !doc.objectKey.startsWith('clean/') || doc.byteSize > 3500000) throw missing();
    const existing = await tx.aiDocumentSource.findFirst({ where: { documentId: doc.id, deletedAt: null } });
    if (existing) return tx.aiDocumentSource.findUnique({ where: { id: existing.id }, select: safe });
    const sourceId = randomUUID();
    await reserveAiQuota(tx, user.id, 'DOCUMENT', sourceId);
    const source = await tx.aiDocumentSource.create({ data: { id: sourceId, ownerUserId: user.id, documentId: doc.id, clientRequestId: input.clientRequestId, sourceSha256: doc.sha256,
      authSessionId: user.sessionId || null, model: aiConfig().model, promptVersion: extractionVersion, consentVersion: AI_DOCUMENT_CONSENT_VERSION }, select: safe });
    await audit(tx, user.id, 'AI_SOURCE_REQUESTED', source.id); return source;
  });
}
export async function reviewAiSource(userId, id, input) {
  return prisma.$transaction(async (tx) => {
    await allowanceLock(tx);
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM ai_document_sources WHERE id = ${id} FOR UPDATE`;
    const source = await owned(userId, id, tx);
    if (!['NEEDS_REVIEW', 'READY'].includes(source.state) || source.revision !== input.revision) throw aiError(409, 'AI_SOURCE_CHANGED', 'The extraction changed. Refresh and review the current version.');
    const pages = await tx.aiDocumentPage.findMany({ where: { sourceId: id }, orderBy: { pageNumber: 'asc' } });
    if (!pages.length || pages.length !== input.pages.length || input.pages.some((p, i) => p.pageNumber !== pages[i].pageNumber) || input.pages.reduce((n, p) => n + p.text.length, 0) > 50000) throw aiError(422, 'AI_INVALID_REQUEST', 'Review every page in its original order.');
    for (const page of input.pages) await tx.aiDocumentPage.update({ where: { sourceId_pageNumber: { sourceId: id, pageNumber: page.pageNumber } }, data: { text: page.text } });
    await tx.aiDocumentSource.update({ where: { id }, data: { state: 'READY', revision: { increment: 1 }, reviewedAt: new Date() } });
    await audit(tx, userId, 'AI_SOURCE_REVIEWED', id); return { id, state: 'READY', revision: source.revision + 1, clinicalVerification: false };
  });
}
export async function deleteAiSource(userId, id) {
  return prisma.$transaction(async (tx) => {
    await allowanceLock(tx);
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const source = await tx.aiDocumentSource.findFirst({ where: { id, ownerUserId: userId, deletedAt: null } });
    if (!source) throw missing();
    await finishAllowance(tx, 'DOCUMENT', id);
    await tx.aiDocumentSource.update({ where: { id }, data: { state: 'DELETED', patientLabels: [], revision: { increment: 1 }, deletedAt: new Date() } });
    await tx.aiDocumentPage.deleteMany({ where: { sourceId: id } });
    await audit(tx, userId, 'AI_SOURCE_DELETED', id);
    return { deleted: true, originalDeleted: false };
  });
}
export async function previewAiSource(userId, id, pageNumber) {
  const source = await owned(userId, id);
  if (!await prisma.aiDocumentPage.findUnique({ where: { sourceId_pageNumber: { sourceId: id, pageNumber } } })) throw missing();
  await audit(prisma, userId, 'AI_SOURCE_PREVIEWED', id); return { ...await ownerDownload(userId, source.documentId), pageNumber };
}

const hash = (text) => createHash('sha256').update(text).digest('hex');
export async function retrieveAiSources(userId, sourceIds, query, db = prisma) {
  if (sourceIds.length && !aiDocumentsAvailable()) throw aiError(503, 'AI_DOCUMENTS_UNAVAILABLE', 'Document AI processing is unavailable.');
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].slice(0, 50);
  const passages = []; const versions = [];
  for (const id of sourceIds) {
    const source = await owned(userId, id, db);
    if (source.state !== 'READY') throw aiError(409, 'AI_SOURCE_NOT_READY', 'Review the extracted pages before asking about this document.');
    const pages = await db.aiDocumentPage.findMany({ where: { sourceId: id }, orderBy: { pageNumber: 'asc' } });
    const version = { sourceId: id, revision: source.revision, sha256: source.sourceSha256 };
    versions.push(version);
    for (const page of pages) {
      // Preserve full short pages and use bounded overlapping windows for larger pages.
      for (let start = 0; start < page.text.length; start += 2000) {
        const text = page.text.slice(start, start + 2400); const normalized = text.toLocaleLowerCase();
        const score = terms.reduce((n, term) => n + Number(normalized.includes(term)), 0);
        passages.push({ ...version, pageNumber: page.pageNumber, text, start, score, hash: hash(text) });
      }
    }
  }
  const selected = passages.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.pageNumber - b.pageNumber || a.start - b.start).slice(0, 6)
    .map((p, i) => ({ ...p, label: `S${i + 1}` }));
  if (sourceIds.length && !selected.length) throw aiError(422, 'AI_SOURCE_EMPTY', 'These pages contain no readable text to explain.');
  return { versions, passages: selected };
}
export async function sourceContextAvailable(userId, context, db = prisma, { lock = false } = {}) {
  if (!context?.versions?.length) return true;
  try {
    for (const version of context.versions) {
      if (lock) {
        const rows = await db.$queryRaw`SELECT d.id FROM medical_documents d JOIN ai_document_sources s ON s.document_id = d.id WHERE s.id = ${version.sourceId} FOR SHARE OF d`;
        if (!rows.length) return false;
      }
      const current = await owned(userId, version.sourceId, db);
      if (current.state !== 'READY' || current.revision !== version.revision || current.sourceSha256 !== version.sha256) return false;
    }
    return true;
  } catch (error) { if (error.code?.startsWith('AI_')) return false; throw error; }
}

export async function readAiDocument(source, { client = privateStorageClient(), db = prisma } = {}) {
  const doc = await db.medicalDocument.findFirst({ where: { id: source.documentId, ...documentWhere(source.ownerUserId), sha256: source.sourceSha256 } });
  if (!doc || !doc.objectKey.startsWith('clean/') || doc.byteSize > 3500000) throw missing();
  await assertPrivateBucket(client, PRIVATE_BUCKETS.clinicalDocuments);
  const result = await client.storage.from(PRIVATE_BUCKETS.clinicalDocuments).download(doc.objectKey);
  if (result.error || !result.data || result.data.size !== doc.byteSize) throw aiError(503, 'AI_DOCUMENT_READ_FAILED', 'Sabi could not read this document.');
  const bytes = Buffer.from(await result.data.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== source.sourceSha256) throw aiError(409, 'AI_SOURCE_CHANGED', 'The document version has changed.');
  return { bytes, contentType: doc.validatedContentType };
}
export async function processAiSourceQueue({ read = readAiDocument, inspect = inspectAiDocument, extract = extractAiDocument } = {}) {
  if (!aiDocumentsAvailable() || !await generationAvailable()) return 0;
  // Unknown outcomes are not automatically charged/replayed after a crash.
  const stale = await prisma.aiDocumentSource.findMany({ where: { state: 'EXTRACTING', startedAt: { lt: new Date(Date.now() - 120000) } }, take: 25 });
  for (const row of stale) await prisma.$transaction(async (tx) => {
    await allowanceLock(tx);
    const changed = await tx.aiDocumentSource.updateMany({ where: { id: row.id, state: 'EXTRACTING' }, data: { state: 'FAILED', errorCode: 'AI_EXTRACTION_INTERRUPTED', finishedAt: new Date() } });
    if (changed.count) await finishAllowance(tx, 'DOCUMENT', row.id);
  });
  const source = await prisma.aiDocumentSource.findFirst({ where: { state: 'QUEUED', deletedAt: null }, orderBy: { createdAt: 'asc' } });
  if (!source) return 0;
  if (!(await prisma.aiDocumentSource.updateMany({ where: { id: source.id, state: 'QUEUED' }, data: { state: 'EXTRACTING', startedAt: new Date() } })).count) return 0;
  try {
    await owned(source.ownerUserId, source.id);
    await requireAiOriginSession(source.authSessionId, source.ownerUserId);
    if (source.model !== aiConfig().model || source.promptVersion !== extractionVersion) throw aiError(409, 'AI_CONFIGURATION_CHANGED', 'The extraction configuration changed.');
    const file = await read(source); const { pageCount } = await inspect(file.bytes, file.contentType);
    const allocation = await dispatchAllowance(source.ownerUserId, 'DOCUMENT', source.id);
    const result = await extract(file.bytes, { ...file, pageCount, tokenBudget: allocation.reservedTokens, maxOutputTokens: allocation.maxOutputTokens });
    await settleAllowance('DOCUMENT', source.id, { usage: result.usage });
    // An injected worker adapter is never an HTTP input; still validate all production results in the adapter.
    await prisma.$transaction(async (tx) => {
      await allowanceLock(tx);
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${source.ownerUserId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM ai_document_sources WHERE id = ${source.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM medical_documents WHERE id = ${source.documentId} FOR SHARE`;
      const current = await owned(source.ownerUserId, source.id, tx);
      if (current.state !== 'EXTRACTING') return;
      await requireGenerationAvailable(tx);
      if (!aiDocumentsAvailable()) throw aiError(503, 'AI_DOCUMENTS_UNAVAILABLE', 'Document processing is unavailable.');
      await requireAiOriginSession(source.authSessionId, source.ownerUserId, tx);
      await tx.aiDocumentPage.createMany({ data: result.pages.map((p) => ({ sourceId: source.id, pageNumber: p.pageNumber, originalText: p.text, text: p.text, uncertain: p.uncertain, fields: p.fields })) });
      await tx.aiDocumentSource.update({ where: { id: source.id }, data: { state: 'NEEDS_REVIEW', patientLabels: result.patientLabels, usage: result.usage, finishedAt: new Date() } });
      await audit(tx, source.ownerUserId, 'AI_SOURCE_EXTRACTED', source.id);
    });
  } catch (error) {
    await settleAllowance('DOCUMENT', source.id, { usage: error.usage, notDispatched: error.aiProviderDispatched === false });
    const allowed = ['AI_EXTRACTION_INCOMPLETE','AI_DOCUMENT_UNSUPPORTED','AI_SOURCE_CHANGED','AI_DOCUMENT_READ_FAILED','AI_CONFIGURATION_CHANGED','AI_SESSION_REVOKED','AI_GENERATION_PAUSED','AI_ACCOUNT_UNAVAILABLE','AI_DOCUMENTS_UNAVAILABLE','AI_PROVIDER_BUSY','AI_PROVIDER_UNAVAILABLE'];
    await prisma.$transaction(async (tx) => {
      await allowanceLock(tx);
      const changed = await tx.aiDocumentSource.updateMany({ where: { id: source.id, state: 'EXTRACTING' }, data: { state: 'FAILED', errorCode: allowed.includes(error.code) ? error.code : 'AI_EXTRACTION_FAILED', finishedAt: new Date() } });
      if (changed.count) await audit(tx, source.ownerUserId, 'AI_SOURCE_FAILED', source.id);
    });
  }
  return 1;
}

export async function purgeRevokedAiSources() {
  const rows = await prisma.aiDocumentSource.findMany({ where: { deletedAt: null, document: { OR: [{ deletedAt: { not: null } }, { status: { in: ['DELETED','INFECTED','REJECTED'] } }] } }, select: { id: true, ownerUserId: true }, take: 10 });
  for (const row of rows) await deleteAiSource(row.ownerUserId, row.id);
  return rows.length;
}
