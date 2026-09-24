import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { protect } from '../../middleware/authMiddleware.js';
import { requirePermission, requirePlatform } from '../../middleware/accessMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { verificationEmailAllowedFor, verificationEmailConfigured } from '../auth/auth.email.js';
import { approvalReadiness } from './platform.approval-readiness.js';
import { evidenceIntakeEnabled, evidenceRoutes, platformEvidenceRoutes } from './platform.evidence.routes.js';

export const publicApplicationRoutes = express.Router();
export const platformApplicationRoutes = express.Router();
publicApplicationRoutes.use(evidenceRoutes);
const text = (max = 160) => z.string().trim().min(1).max(max);
const optional = (max = 160) => z.string().trim().max(max);
const email = z.email().max(254).transform((value) => value.toLowerCase());
const empty = z.object({}).strict();
const paramsId = z.object({ id: z.uuid() }).strict();
const body = z.object({
  clientDraftId: z.string().regex(/^app_[A-Za-z0-9_-]{6,64}$/),
  owner: z.object({ firstName: text(80), lastName: text(80), workEmail: email, phone: text(40), termsAccepted: z.literal(true), privacyAccepted: z.literal(true) }).strict(),
  organization: z.object({ legalName: text(200), tradingName: text(200), facilityType: text(100), ownershipType: text(100), country: text(80), state: text(100), lga: text(100), city: text(100), address: text(500), website: optional(500), officialEmail: email, officialPhone: text(40) }).strict(),
  corporate: z.object({ registrationNumber: optional(100), registeredLegalName: optional(200), registrationType: text(80), taxIdentificationNumber: optional(100), incorporationDate: optional(30) }).strict(),
  regulatoryRegistration: z.object({ registrationStatus: text(40), regulatorId: text(80), registrationNumber: text(100), dateIssued: optional(30), expiryDate: optional(30), currentStatus: text(80), facilityCategory: optional(100) }).strict(),
  operatingOfficer: z.object({ fullName: text(160), role: text(100), profession: text(100), regulatorId: text(80), registrationNumber: text(100), practisingLicenceNumber: text(100), licenceExpiryDate: text(30), email, phone: text(40) }).strict(),
  facility: z.object({ facilities: z.number().int().min(1).max(10000), branches: z.number().int().min(0).max(10000), beds: z.number().int().min(0).max(100000), staff: z.number().int().min(1).max(1000000), doctors: z.number().int().min(0).max(1000000), nurses: z.number().int().min(0).max(1000000), monthlyPatients: z.number().int().min(0).max(100000000), openingHours: text(100), services: z.array(text(100)).max(30) }).strict(),
  selectedProducts: z.array(z.enum(['emr', 'workforce', 'accounting', 'pharmacy'])).min(1).max(4),
  packageId: z.uuid(),
  billingCycle: z.enum(['Monthly', 'Annual']),
}).strict().superRefine((value, context) => {
  if (value.facility.doctors + value.facility.nurses > value.facility.staff) context.addIssue({ code: 'custom', path: ['facility', 'staff'], message: 'Clinical staff cannot exceed total staff.' });
  if (value.organization.ownershipType !== 'Public' && (!value.corporate.registrationNumber || !value.corporate.registeredLegalName)) context.addIssue({ code: 'custom', path: ['corporate'], message: 'Corporate registration is required for this ownership type.' });
  if (new Set(value.selectedProducts).size !== value.selectedProducts.length) context.addIssue({ code: 'custom', path: ['selectedProducts'], message: 'Products must be unique.' });
});
const submission = z.object({ body, query: empty, params: empty });
const verification = z.object({ body: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), query: empty, params: paramsId });
const list = z.object({ body: empty.optional(), query: z.object({ status: z.enum(['AWAITING_EMAIL', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED']).default('SUBMITTED'), page: z.coerce.number().int().min(1).max(200).default(1) }).strict(), params: empty });
const detail = z.object({ body: empty.optional(), query: empty, params: paramsId });
const reviewNote = z.object({ body: z.object({ note: text(2000).refine((value) => value.length >= 10) }).strict(), query: empty, params: paramsId });
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const responseError = (res, code, status) => res.status(status).json({ status: 'error', error: { code, message: code.replaceAll('_', ' ').toLowerCase() } });
const publicSummary = (row) => ({ id: row.id, reference: row.reference, status: row.status, createdAt: row.createdAt, submittedAt: row.submittedAt });
const reviewerDetail = { id: true, reference: true, organizationName: true, status: true, createdAt: true, submittedAt: true, emailVerifiedAt: true, details: true, packageId: true, packageVersionId: true, billingCycle: true };
const safe = (work) => async (req, res, next) => { try { await work(req, res); } catch (error) {
  if (error.code === 'P2002') return responseError(res, 'APPLICATION_CONFLICT', 409);
  return next(error);
} };

async function sendVerification(emailAddress, id, token) {
  try {
    const url = `${process.env.CLIENT_URL.replace(/\/$/, '')}/register/organization/verify/${id}#${token}`;
    const response = await globalThis.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.PASSWORD_RESET_EMAIL_FROM, to: [emailAddress], subject: 'Verify your Sabi hospital application', text: `Confirm your email to send your hospital application to Sabi for review. This link expires in 24 hours and can be used once.\n\n${url}\n\nIf you did not apply, ignore this email.` }),
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`[platform] Application email provider returned HTTP ${response.status}.`);
    return response.ok;
  } catch {
    console.error('[platform] Application email delivery failed.');
    return false;
  }
}

publicApplicationRoutes.post('/', createLimiter({ kind: 'hospital-application', max: 5 }), validate(submission), safe(async (req, res) => {
  if (!verificationEmailConfigured() || !verificationEmailAllowedFor(req.body.owner.workEmail) || !/^https:\/\/[^/]+$/.test(process.env.CLIENT_URL || '')) return responseError(res, 'VERIFICATION_EMAIL_UNAVAILABLE', 503);
  const { clientDraftId, packageId, billingCycle, owner, ...details } = req.body;
  const requestHash = hash(JSON.stringify(req.body));
  const existing = await prisma.platformApplication.findUnique({ where: { clientDraftId } });
  if (existing && (existing.requestHash !== requestHash || existing.ownerEmail !== owner.workEmail)) return responseError(res, 'APPLICATION_CONFLICT', 409);
  if (existing?.status !== undefined && existing.status !== 'AWAITING_EMAIL') return res.set('Cache-Control', 'no-store').json({ status: 'success', data: publicSummary(existing) });
  const pkg = existing ? null : await prisma.platformPackage.findUnique({ where: { id: packageId }, include: { versions: { where: { status: 'PUBLISHED' } } } });
  const version = pkg?.versions.find((item) => item.version === pkg.publishedVersion);
  if (!existing && (!pkg?.active || !version)) return responseError(res, 'PACKAGE_NOT_PUBLISHED', 409);
  const token = crypto.randomBytes(32).toString('hex');
  const data = { requestHash, ownerEmail: owner.workEmail, organizationName: details.organization.tradingName, details: { owner, ...details }, packageId, packageVersionId: existing?.packageVersionId ?? version.id, billingCycle, verificationTokenHash: hash(token), verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60_000) };
  const row = existing
    ? await prisma.platformApplication.update({ where: { id: existing.id }, data })
    : await prisma.platformApplication.create({ data: { clientDraftId, reference: `SABI-APP-${new Date().getUTCFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, ...data } });
  const delivered = await sendVerification(owner.workEmail, row.id, token);
  if (!delivered) return responseError(res, 'VERIFICATION_EMAIL_UNAVAILABLE', 503);
  res.status(existing ? 200 : 202).set('Cache-Control', 'no-store').json({ status: 'success', data: publicSummary(row) });
}));

publicApplicationRoutes.post('/:id/verify', createLimiter({ kind: 'hospital-verification', max: 10 }), validate(verification), safe(async (req, res) => {
  const evidenceAccessToken = evidenceIntakeEnabled() ? crypto.randomBytes(32).toString('hex') : null;
  const changed = await prisma.platformApplication.updateMany({ where: { id: req.params.id, status: 'AWAITING_EMAIL', verificationTokenHash: hash(req.body.token), verificationExpiresAt: { gt: new Date() } }, data: { status: 'SUBMITTED', verificationTokenHash: null, verificationExpiresAt: null, emailVerifiedAt: new Date(), submittedAt: new Date(), ...(evidenceAccessToken ? { evidenceAccessTokenHash: hash(evidenceAccessToken), evidenceAccessExpiresAt: new Date(Date.now() + 30 * 60_000) } : {}) } });
  if (changed.count !== 1) return responseError(res, 'VERIFICATION_LINK_INVALID', 400);
  const row = await prisma.platformApplication.findUnique({ where: { id: req.params.id } });
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { ...publicSummary(row), ...(evidenceAccessToken ? { evidenceAccessToken } : {}) } });
}));

platformApplicationRoutes.use(protect, requirePlatform, requirePermission('platform.onboarding.review'), requireRecentMfa);
platformApplicationRoutes.use(platformEvidenceRoutes);
platformApplicationRoutes.get('/', validate(list), safe(async (req, res) => {
  const rows = await prisma.platformApplication.findMany({ where: { status: req.query.status }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (req.query.page - 1) * 50, take: 51, select: { id: true, reference: true, organizationName: true, status: true, createdAt: true, submittedAt: true, packageId: true, packageVersionId: true } });
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { items: rows.slice(0, 50), nextPage: rows.length > 50 ? req.query.page + 1 : null } });
}));
platformApplicationRoutes.get('/:id', validate(detail), safe(async (req, res) => {
  const row = await prisma.platformApplication.findUnique({ where: { id: req.params.id }, select: reviewerDetail });
  if (!row) return responseError(res, 'APPLICATION_NOT_FOUND', 404);
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: row });
}));

platformApplicationRoutes.get('/:id/approval-readiness', validate(detail), safe(async (req, res) => {
  const row = await prisma.platformApplication.findUnique({
    where: { id: req.params.id },
    select: {
      status: true, emailVerifiedAt: true, details: true,
      packageVersion: { select: { status: true, moduleKeys: true } },
      evidence: { select: { id: true, requirementKey: true, createdAt: true, storageBucket: true, scanStatus: true, reviewStatus: true, reviewedByUserId: true, reviewedAt: true, expiresAt: true } },
    },
  });
  if (!row) return responseError(res, 'APPLICATION_NOT_FOUND', 404);
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: approvalReadiness(row) });
}));

platformApplicationRoutes.post('/:id/start-review', createLimiter({ kind: 'hospital-review', max: 20 }), validate(detail), safe(async (req, res) => {
  const row = await prisma.$transaction(async (tx) => {
    const changed = await tx.platformApplication.updateMany({ where: { id: req.params.id, status: 'SUBMITTED', emailVerifiedAt: { not: null } }, data: { status: 'UNDER_REVIEW' } });
    if (changed.count !== 1) return null;
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'PLATFORM_APPLICATION_REVIEW_STARTED', description: 'Hospital application review started', meta: { applicationId: req.params.id } } });
    return tx.platformApplication.findUnique({ where: { id: req.params.id }, select: reviewerDetail });
  });
  if (!row) return responseError(res, 'APPLICATION_NOT_READY', 409);
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: row });
}));

platformApplicationRoutes.get('/:id/review-notes', validate(detail), safe(async (req, res) => {
  const application = await prisma.platformApplication.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!application) return responseError(res, 'APPLICATION_NOT_FOUND', 404);
  const items = await prisma.platformApplicationReviewNote.findMany({
    where: { applicationId: req.params.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
    select: { id: true, reviewerId: true, note: true, createdAt: true },
  });
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { items } });
}));

platformApplicationRoutes.post('/:id/review-notes', createLimiter({ kind: 'hospital-review-note', max: 30 }), validate(reviewNote), safe(async (req, res) => {
  const row = await prisma.$transaction(async (tx) => {
    const application = await tx.platformApplication.findUnique({ where: { id: req.params.id }, select: { status: true } });
    if (!application || application.status !== 'UNDER_REVIEW') return null;
    const created = await tx.platformApplicationReviewNote.create({
      data: { applicationId: req.params.id, reviewerId: req.user.id, note: req.body.note },
      select: { id: true, reviewerId: true, note: true, createdAt: true },
    });
    await tx.activityLog.create({ data: {
      userId: req.user.id, type: 'PLATFORM_APPLICATION_REVIEW_NOTE_ADDED',
      description: 'Hospital application reviewer note added',
      meta: { applicationId: req.params.id, reviewNoteId: created.id },
    } });
    return created;
  });
  if (!row) return responseError(res, 'APPLICATION_NOT_READY', 409);
  res.status(201).set('Cache-Control', 'no-store').json({ status: 'success', data: row });
}));
