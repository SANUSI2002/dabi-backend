import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { assertPrivateBucket, PRIVATE_BUCKETS, PrivateStorageError, privateStorageClient, signedEvidencePreview, uploadPrivateObject } from '../../config/privateStorage.js';
import { createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { requirePermission } from '../../middleware/accessMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { verificationEmailAllowedFor, verificationEmailConfigured } from '../auth/auth.email.js';
import { requiredEvidence } from './platform.approval-readiness.js';
import { evidenceWorkflowAvailable, unscannedExceptionEnabled } from './platform.evidence-mode.js';

export const evidenceRoutes = express.Router();
export const platformEvidenceRoutes = express.Router();
export const evidenceIntakeEnabled = () => process.env.HOSPITAL_EVIDENCE_INTAKE_ENABLED === 'true' && evidenceWorkflowAvailable();
export const evidenceReviewEnabled = () => process.env.HOSPITAL_EVIDENCE_REVIEW_ENABLED === 'true' && evidenceWorkflowAvailable();

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const permittedStatus = ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION'];
const routeParams = z.object({ id: z.string().regex(uuid) }).strict();
const accessRequest = z.object({ body: z.object({ email: z.email().max(254).transform((value) => value.toLowerCase()) }).strict(), query: z.object({}).strict(), params: routeParams });
const listRequest = z.object({ body: z.object({}).strict().optional(), query: z.object({}).strict(), params: routeParams });
const evidenceParams = z.object({ id: z.string().regex(uuid), evidenceId: z.string().regex(uuid) }).strict();
const previewRequest = z.object({ body: z.object({}).strict().optional(), query: z.object({}).strict(), params: evidenceParams });
const exceptionRequest = z.object({ body: z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().trim().min(20).max(500),
  acknowledgement: z.literal('I ACCEPT THE UNSCANNED DOCUMENT RISK'),
}).strict(), query: z.object({}).strict(), params: evidenceParams });
const decisionRequest = z.object({
  body: z.discriminatedUnion('decision', [
    z.object({ decision: z.literal('VERIFIED'), sourceName: z.string().trim().min(3).max(120), reference: z.string().trim().min(3).max(160), note: z.string().trim().max(1000).optional() }).strict(),
    z.object({ decision: z.literal('REJECTED'), note: z.string().trim().min(10).max(1000) }).strict(),
  ]), query: z.object({}).strict(), params: evidenceParams,
});
const errorResponse = (res, code, status) => res.status(status).set('Cache-Control', 'no-store').json({ status: 'error', error: { code, message: code.replaceAll('_', ' ').toLowerCase() } });
const evidenceSelect = { id: true, requirementKey: true, fileName: true, contentType: true, sizeBytes: true, sha256: true, scanStatus: true, scannedAt: true, unscannedDownloadedAt: true, unscannedExceptionAt: true, reviewStatus: true, reviewedAt: true, createdAt: true };
const withErrors = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error instanceof PrivateStorageError) return errorResponse(res, error.code, error.code === 'EVIDENCE_ACCESS_DENIED' ? 403 : error.code === 'PRIVATE_STORAGE_UPLOAD_INVALID' ? 400 : 503);
  return next(error);
} };

async function applicationForToken(id, token) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) return null;
  return prisma.platformApplication.findFirst({
    where: { id, evidenceAccessTokenHash: hash(token), evidenceAccessExpiresAt: { gt: new Date() }, emailVerifiedAt: { not: null }, status: { in: permittedStatus } },
    select: { id: true, status: true, details: true },
  });
}

async function emailEvidenceLink(email, id, token) {
  try {
    const url = `${process.env.CLIENT_URL.replace(/\/$/, '')}/register/organization/evidence/${id}#${token}`;
    const response = await globalThis.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.PASSWORD_RESET_EMAIL_FROM, to: [email], subject: 'Upload evidence for your Sabi hospital application',
        text: `Use this link to submit documents for your hospital application. It expires in 30 minutes. Upload only documents requested by Sabi. Do not upload patient records.\n\n${url}\n\nIf you did not request this link, ignore this email.`,
      }),
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`[platform] Evidence-link provider returned HTTP ${response.status}.`);
    return response.ok;
  } catch {
    console.error('[platform] Evidence-link delivery failed.');
    return false;
  }
}

// A generic response prevents application-ID and owner-email enumeration.
evidenceRoutes.post('/:id/evidence-access', createLimiter({ kind: 'hospital-evidence-link', max: 3 }), validate(accessRequest), withErrors(async (req, res) => {
  const generic = () => res.status(202).set('Cache-Control', 'no-store').json({ status: 'success', message: 'If this verified application can accept documents, an access link will be emailed.' });
  if (!evidenceIntakeEnabled() || !verificationEmailConfigured() || !verificationEmailAllowedFor(req.body.email) || !/^https:\/\/[^/]+$/.test(process.env.CLIENT_URL || '')) return generic();
  const application = await prisma.platformApplication.findUnique({ where: { id: req.params.id }, select: { ownerEmail: true, status: true, emailVerifiedAt: true } });
  if (!application || application.ownerEmail !== req.body.email || !application.emailVerifiedAt || !permittedStatus.includes(application.status)) return generic();
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const changed = await prisma.platformApplication.updateMany({
    where: { id: req.params.id, OR: [{ evidenceAccessSentAt: null }, { evidenceAccessSentAt: { lt: new Date(now.getTime() - 10 * 60_000) } }], status: { in: permittedStatus } },
    data: { evidenceAccessTokenHash: hash(token), evidenceAccessExpiresAt: new Date(now.getTime() + 30 * 60_000), evidenceAccessSentAt: now },
  });
  if (changed.count !== 1) return generic();
  const delivered = await emailEvidenceLink(req.body.email, req.params.id, token);
  if (!delivered) await prisma.platformApplication.updateMany({ where: { id: req.params.id, evidenceAccessTokenHash: hash(token) }, data: { evidenceAccessTokenHash: null, evidenceAccessExpiresAt: null, evidenceAccessSentAt: null } });
  return generic();
}));

evidenceRoutes.get('/:id/evidence', validate(listRequest), withErrors(async (req, res) => {
  if (!evidenceIntakeEnabled()) return errorResponse(res, 'EVIDENCE_INTAKE_DISABLED', 503);
  const application = await applicationForToken(req.params.id, req.get('X-Sabi-Evidence-Token'));
  if (!application) return errorResponse(res, 'EVIDENCE_ACCESS_DENIED', 403);
  const items = await prisma.platformApplicationEvidence.findMany({ where: { applicationId: application.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, select: evidenceSelect });
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { requiredEvidence: requiredEvidence(application.details), items } });
}));

const rawEvidence = express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: '10mb', inflate: false });
evidenceRoutes.put('/:id/evidence/:requirementKey', createLimiter({ kind: 'hospital-evidence-upload', max: 12 }), (req, res, next) => {
  if (!evidenceIntakeEnabled()) return errorResponse(res, 'EVIDENCE_INTAKE_DISABLED', 503);
  return rawEvidence(req, res, (error) => {
    if (error) return errorResponse(res, error.type === 'entity.too.large' ? 'EVIDENCE_TOO_LARGE' : 'EVIDENCE_UPLOAD_INVALID', error.type === 'entity.too.large' ? 413 : 400);
    return next();
  });
}, withErrors(async (req, res) => {
  if (!uuid.test(req.params.id) || !/^[A-Z_]{4,64}$/.test(req.params.requirementKey) || Object.keys(req.query).length) return errorResponse(res, 'EVIDENCE_UPLOAD_INVALID', 400);
  const contentType = req.get('Content-Type')?.toLowerCase();
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(contentType) || !Buffer.isBuffer(req.body)) return errorResponse(res, 'EVIDENCE_UPLOAD_INVALID', 415);
  const application = await applicationForToken(req.params.id, req.get('X-Sabi-Evidence-Token'));
  if (!application) return errorResponse(res, 'EVIDENCE_ACCESS_DENIED', 403);
  const requirements = requiredEvidence(application.details);
  if (!requirements?.includes(req.params.requirementKey)) return errorResponse(res, 'EVIDENCE_REQUIREMENT_INVALID', 400);
  const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[contentType];
  const path = `applications/${application.id}/${crypto.randomUUID()}.${extension}`;
  const client = privateStorageClient();
  const uploaded = await uploadPrivateObject(client, { bucket: PRIVATE_BUCKETS.hospitalEvidenceQuarantine, path, bytes: req.body, contentType });
  let item;
  try {
    item = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM platform_applications WHERE id = ${application.id} AND status IN ('SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION') FOR UPDATE`;
      if (locked.length !== 1) throw new PrivateStorageError('EVIDENCE_ACCESS_DENIED');
      const created = await tx.platformApplicationEvidence.create({ data: {
        applicationId: application.id, requirementKey: req.params.requirementKey,
        fileName: `${req.params.requirementKey.toLowerCase()}.${extension}`, contentType, sizeBytes: req.body.length, sha256: hash(req.body),
        storageBucket: uploaded.bucket, storageKey: uploaded.path, scanStatus: 'PENDING', reviewStatus: 'PENDING',
      }, select: evidenceSelect });
      await tx.platformApplicationEvidenceEvent.create({ data: {
        evidenceId: created.id, eventType: 'UPLOADED', actorKind: 'EMAIL_VERIFIED_APPLICANT',
        details: { applicationId: application.id, requirementKey: created.requirementKey, sizeBytes: created.sizeBytes, sha256: created.sha256 },
      } });
      return created;
    });
  } catch (error) {
    // Only remove the exact unrecorded object created by this request.
    const cleanup = await client.storage.from(uploaded.bucket).remove([uploaded.path]);
    if (cleanup.error) console.error('[platform] Orphaned evidence object requires operator cleanup.');
    throw error;
  }
  res.status(201).set('Cache-Control', 'no-store').json({ status: 'success', data: item });
}));

// The parent router requires an authorized platform reviewer with recent MFA.
platformEvidenceRoutes.get('/:id/evidence', validate(listRequest), withErrors(async (req, res) => {
  const result = await prisma.$transaction(async (tx) => {
    const application = await tx.platformApplication.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!application) return null;
    const items = await tx.platformApplicationEvidence.findMany({ where: { applicationId: application.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, select: evidenceSelect });
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'PLATFORM_APPLICATION_EVIDENCE_LISTED', description: 'Hospital evidence metadata viewed', meta: { applicationId: application.id } } });
    return items;
  });
  if (!result) return errorResponse(res, 'APPLICATION_NOT_FOUND', 404);
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { items: result, previewAvailable: evidenceReviewEnabled(), unscannedExceptionAvailable: unscannedExceptionEnabled() } });
}));

// This is a download, never an inline preview. The file remains marked
// unscanned and in private quarantine until an operator explicitly accepts
// the time-limited exception; no endpoint labels it CLEAN.
platformEvidenceRoutes.get('/:id/evidence/:evidenceId/unscanned-download', requirePermission('platform.onboarding.approve'), createLimiter({ kind: 'unscanned-evidence-download', max: 10 }), validate(previewRequest), withErrors(async (req, res) => {
  if (!unscannedExceptionEnabled()) return errorResponse(res, 'UNSCANNED_EXCEPTION_DISABLED', 503);
  const row = await prisma.platformApplicationEvidence.findFirst({
    where: { id: req.params.evidenceId, applicationId: req.params.id, scanStatus: 'PENDING', storageBucket: PRIVATE_BUCKETS.hospitalEvidenceQuarantine, application: { status: 'UNDER_REVIEW' } },
    select: { id: true, applicationId: true, requirementKey: true, storageBucket: true, storageKey: true, sha256: true },
  });
  if (!row) return errorResponse(res, 'UNSCANNED_DOWNLOAD_UNAVAILABLE', 404);
  const latest = await prisma.platformApplicationEvidence.findFirst({ where: { applicationId: req.params.id, requirementKey: row.requirementKey }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
  if (latest?.id !== row.id) return errorResponse(res, 'EVIDENCE_VERSION_SUPERSEDED', 409);
  const client = privateStorageClient();
  await assertPrivateBucket(client, row.storageBucket);
  const { data, error } = await client.storage.from(row.storageBucket).createSignedUrl(row.storageKey, 60, { download: true });
  if (error || !data?.signedUrl) throw new PrivateStorageError('PRIVATE_STORAGE_PREVIEW_FAILED');
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.platformApplicationEvidence.update({ where: { id: row.id }, data: { unscannedDownloadedByUserId: req.user.id, unscannedDownloadedAt: now } });
    await tx.platformApplicationEvidenceEvent.create({ data: { evidenceId: row.id, eventType: 'UNSCANNED_DOWNLOAD_ISSUED', actorKind: 'PLATFORM_REVIEWER', actorId: req.user.id, details: { sha256: row.sha256 } } });
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'PLATFORM_UNSCANNED_EVIDENCE_DOWNLOADED', description: 'Unscanned hospital evidence download issued', meta: { applicationId: row.applicationId, evidenceId: row.id } } });
  });
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { url: data.signedUrl, sha256: row.sha256, expiresInSeconds: 60, warning: 'UNSCANNED_FILE' } });
}));

platformEvidenceRoutes.post('/:id/evidence/:evidenceId/unscanned-exception', requirePermission('platform.onboarding.approve'), createLimiter({ kind: 'unscanned-evidence-exception', max: 10 }), validate(exceptionRequest), withErrors(async (req, res) => {
  if (!unscannedExceptionEnabled()) return errorResponse(res, 'UNSCANNED_EXCEPTION_DISABLED', 503);
  const now = new Date();
  const row = await prisma.platformApplicationEvidence.findFirst({
    where: { id: req.params.evidenceId, applicationId: req.params.id, scanStatus: 'PENDING', reviewStatus: 'PENDING', storageBucket: PRIVATE_BUCKETS.hospitalEvidenceQuarantine, application: { status: 'UNDER_REVIEW' } },
    select: { id: true, requirementKey: true, sha256: true, unscannedDownloadedByUserId: true, unscannedDownloadedAt: true },
  });
  if (!row || row.sha256 !== req.body.sha256 || row.unscannedDownloadedByUserId !== req.user.id
    || !row.unscannedDownloadedAt || row.unscannedDownloadedAt < new Date(now.getTime() - 2 * 60 * 60_000)) return errorResponse(res, 'UNSCANNED_EXCEPTION_NOT_READY', 409);
  const latest = await prisma.platformApplicationEvidence.findFirst({ where: { applicationId: req.params.id, requirementKey: row.requirementKey }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
  if (latest?.id !== row.id) return errorResponse(res, 'EVIDENCE_VERSION_SUPERSEDED', 409);
  const changed = await prisma.$transaction(async (tx) => {
    const updated = await tx.platformApplicationEvidence.updateMany({ where: { id: row.id, scanStatus: 'PENDING', reviewStatus: 'PENDING', unscannedDownloadedByUserId: req.user.id, unscannedDownloadedAt: { gt: new Date(now.getTime() - 2 * 60 * 60_000) } }, data: {
      scanStatus: 'UNSCANNED_EXCEPTION', unscannedExceptionByUserId: req.user.id, unscannedExceptionAt: now, unscannedExceptionNote: req.body.note,
    } });
    if (updated.count !== 1) return false;
    await tx.platformApplicationEvidenceEvent.create({ data: { evidenceId: row.id, eventType: 'UNSCANNED_EXCEPTION_ACCEPTED', actorKind: 'PLATFORM_REVIEWER', actorId: req.user.id, details: { sha256: row.sha256, note: req.body.note } } });
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'PLATFORM_UNSCANNED_EXCEPTION_ACCEPTED', description: 'Temporary unscanned evidence exception accepted', meta: { applicationId: req.params.id, evidenceId: row.id } } });
    return true;
  });
  if (!changed) return errorResponse(res, 'UNSCANNED_EXCEPTION_CONFLICT', 409);
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { id: row.id, scanStatus: 'UNSCANNED_EXCEPTION', unscannedExceptionAt: now } });
}));

platformEvidenceRoutes.get('/:id/evidence/:evidenceId/preview', validate(previewRequest), withErrors(async (req, res) => {
  if (!evidenceReviewEnabled()) return errorResponse(res, 'EVIDENCE_REVIEW_DISABLED', 503);
  const row = await prisma.platformApplicationEvidence.findFirst({
    where: { id: req.params.evidenceId, applicationId: req.params.id, scanStatus: 'CLEAN', storageBucket: PRIVATE_BUCKETS.hospitalEvidenceClean },
    select: { id: true, applicationId: true, scanStatus: true, storageBucket: true, storageKey: true },
  });
  if (!row) return errorResponse(res, 'EVIDENCE_PREVIEW_UNAVAILABLE', 404);
  const url = await signedEvidencePreview(privateStorageClient(), row);
  await prisma.activityLog.create({ data: { userId: req.user.id, type: 'PLATFORM_APPLICATION_EVIDENCE_PREVIEWED', description: 'Clean hospital evidence preview link issued', meta: { applicationId: row.applicationId, evidenceId: row.id } } });
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { url, expiresInSeconds: 60 } });
}));

platformEvidenceRoutes.post('/:id/evidence/:evidenceId/review', validate(decisionRequest), withErrors(async (req, res) => {
  if (!evidenceReviewEnabled()) return errorResponse(res, 'EVIDENCE_REVIEW_DISABLED', 503);
  const application = await prisma.platformApplication.findUnique({ where: { id: req.params.id }, select: { status: true } });
  if (application?.status !== 'UNDER_REVIEW') return errorResponse(res, 'APPLICATION_NOT_UNDER_REVIEW', 409);
  const eligibleScan = { OR: [
    { scanStatus: 'CLEAN', storageBucket: PRIVATE_BUCKETS.hospitalEvidenceClean },
    ...(unscannedExceptionEnabled() ? [{ scanStatus: 'UNSCANNED_EXCEPTION', storageBucket: PRIVATE_BUCKETS.hospitalEvidenceQuarantine, unscannedExceptionByUserId: { not: null }, unscannedExceptionAt: { not: null } }] : []),
  ] };
  const document = await prisma.platformApplicationEvidence.findFirst({
    where: { id: req.params.evidenceId, applicationId: req.params.id, ...eligibleScan, reviewStatus: 'PENDING' },
    select: { id: true, requirementKey: true, expiresAt: true },
  });
  if (!document || (document.expiresAt && document.expiresAt <= new Date())) return errorResponse(res, 'EVIDENCE_REVIEW_UNAVAILABLE', 409);
  const latest = await prisma.platformApplicationEvidence.findFirst({
    where: { applicationId: req.params.id, requirementKey: document.requirementKey }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
  });
  if (latest?.id !== document.id) return errorResponse(res, 'EVIDENCE_VERSION_SUPERSEDED', 409);
  const now = new Date();
  const changed = await prisma.$transaction(async (tx) => {
    const updated = await tx.platformApplicationEvidence.updateMany({
      where: { id: document.id, applicationId: req.params.id, ...eligibleScan, reviewStatus: 'PENDING' },
      data: { reviewStatus: req.body.decision, reviewedByUserId: req.user.id, reviewedAt: now },
    });
    if (updated.count !== 1) return false;
    await tx.platformApplicationEvidenceEvent.create({ data: {
      evidenceId: document.id, eventType: req.body.decision === 'VERIFIED' ? 'AUTHENTICITY_VERIFIED' : 'AUTHENTICITY_REJECTED',
      actorKind: 'PLATFORM_REVIEWER', actorId: req.user.id,
      details: req.body.decision === 'VERIFIED' ? { sourceName: req.body.sourceName, reference: req.body.reference, note: req.body.note ?? '' } : { note: req.body.note },
    } });
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'PLATFORM_APPLICATION_EVIDENCE_REVIEWED', description: 'Hospital evidence authenticity decision recorded', meta: { applicationId: req.params.id, evidenceId: document.id, decision: req.body.decision } } });
    return true;
  });
  if (!changed) return errorResponse(res, 'EVIDENCE_REVIEW_CONFLICT', 409);
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { id: document.id, reviewStatus: req.body.decision, reviewedAt: now } });
}));
