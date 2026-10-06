import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { protect } from '../../middleware/authMiddleware.js';
import { requirePlatform, requirePermission } from '../../middleware/accessMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { registrationLimiter, verificationRequestLimiter, verificationConfirmLimiter, createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { assertPrivateBucket, privateStorageClient } from '../../config/privateStorage.js';
import { evidenceUploadMaxBytes } from '../../config/evidenceScanner.js';
import * as auth from '../auth/auth.model.js';
import * as V from './onboarding.validator.js';
import * as S from './onboarding.service.js';
import * as professionals from '../professionals/professionals.model.js';
import { eligibleDocument, latestCredentials } from './onboarding.policy.js';
import { PROFESSION_CATALOG, PORTAL_PROFESSIONS } from '../professionals/professionCatalog.js';

export const doctorOnboardingRoutes = express.Router();
export const platformDoctorRoutes = express.Router();
const wrap = (handler) => async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try { await handler(req, res); }
  catch (e) {
    if ([400, 403, 404, 409, 413, 415, 503].includes(e.status)) return res.status(e.status).json({ status: 'error', message: e.message });
    if (e.code === 'SELF') return res.status(403).json({ status: 'error', message: 'You cannot review your own doctor application.' });
    if (['NOT_FOUND', 'INVALID'].includes(e.code)) return res.status(409).json({ status: 'error', message: 'This doctor application cannot receive that decision.' });
    if (e.code === 'PRIVATE_STORAGE_UPLOAD_INVALID') return res.status(400).json({ status: 'error', message: 'The document content does not match the selected file type.' });
    if (e.name === 'PrivateStorageError') return res.status(503).json({ status: 'error', message: 'Private document storage is unavailable. Please retry later.' });
    return res.status(503).json({ status: 'error', message: 'Doctor onboarding is temporarily unavailable. Please retry later.' });
  }
};
const uuidParams = z.object({ params: z.object({ id: z.uuid(), credentialId: z.uuid().optional() }) });
const principal = (req) => ({ userId: req.user?.id });
doctorOnboardingRoutes.get('/registration-config', wrap(async (req, res) => res.json({ data: { enabled: S.enabled(), professions: PROFESSION_CATALOG, maxUploadBytes: Math.min(evidenceUploadMaxBytes(), 5 * 1024 * 1024) } })));
doctorOnboardingRoutes.post('/register', registrationLimiter, validate(V.registrationSchema), wrap(async (req, res) => res.status(201).json({ data: await S.register(req.body) })));
doctorOnboardingRoutes.post('/register-professional', registrationLimiter, validate(V.professionalRegistrationSchema), wrap(async (req, res) => res.status(201).json({ data: await S.register(req.body) })));
doctorOnboardingRoutes.post('/resend-verification', verificationRequestLimiter, validate(V.resendSchema), wrap(async (req, res) => {
  const user = await auth.findUserByEmail(req.body.email);
  const profile = user && await prisma.professionalProfile.findUnique({ where: { userId: user.id }, select: { professionType: true } });
  if (PORTAL_PROFESSIONS.includes(profile?.professionType) && user.accountStatus === 'PENDING' && !user.emailVerifiedAt) {
    const latest = await auth.latestEmailVerificationToken(user.id);
    if (!latest || latest.createdAt < new Date(Date.now() - 60000)) await S.sendVerification(user).catch(() => false);
  }
  res.status(202).json({ message: 'If an eligible unverified doctor account exists, a verification email has been requested.' });
}));
doctorOnboardingRoutes.post('/verify-email', verificationConfirmLimiter, validate(V.verifySchema), wrap(async (req, res) => {
  const profile = await prisma.professionalProfile.findUnique({ where: { userId: req.body.uid }, select: { professionType: true } });
  if (!PORTAL_PROFESSIONS.includes(profile?.professionType) || !await auth.confirmEmailVerificationToken(req.body.uid, S.hash(req.body.token))) S.fail('This verification link is invalid, expired or already used. Request a fresh link.', 400);
  res.json({ data: { verified: true } });
}));
doctorOnboardingRoutes.put('/applications/:id/credentials/:kind', createLimiter({ kind: 'doctor-credential-upload', max: 12 }), protect,
  express.raw({ type: ['application/pdf', 'image/png', 'image/jpeg'], limit: '5mb', inflate: false }), wrap(async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) S.fail('Invalid application.', 400);
    res.status(201).json({ data: await S.upload(req.params.id, req.params.kind, req.body, req.get('Content-Type')?.toLowerCase(), principal(req)) });
  }));
doctorOnboardingRoutes.post('/applications/:id/submit', createLimiter({ kind: 'doctor-submit', max: 10 }), validate(uuidParams), protect, wrap(async (req, res) => res.json({ data: await S.submit(req.params.id, principal(req)) })));
doctorOnboardingRoutes.patch('/applications/:id/details',validate(uuidParams),validate(V.detailsPatchSchema),protect,wrap(async(req,res)=>res.json({data:await S.updateDetails(req.params.id,req.body,principal(req))})));
doctorOnboardingRoutes.get('/me', protect, wrap(async (req, res) => res.json({ data: await S.detail(null, req.user.id) })));

platformDoctorRoutes.use(protect, requirePlatform, requirePermission('platform.onboarding.review'), requireRecentMfa);
platformDoctorRoutes.get('/', wrap(async (req, res) => {
  const page = Number(req.query.page || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 200) S.fail('Invalid page.', 400);
  const status = req.query.status || 'PENDING';
  if (!['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'].includes(status)) S.fail('Invalid status.', 400);
  const items = await prisma.professionalProfile.findMany({ where: { professionType: { in: PORTAL_PROFESSIONS }, verificationStatus: status }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 51,
    select: { id: true, professionType: true, specialty: true, verificationStatus: true, createdAt: true, user: { select: { email: true, full_name: true, emailVerifiedAt: true } }, doctorApplication: { select: { submittedAt: true, stage: true } } } });
  await S.audit(prisma, req.user.id, 'DOCTOR_REVIEW_QUEUE_VIEWED', { page, status });
  res.json({ data: { items: items.slice(0, 50), nextPage: items.length > 50 ? page + 1 : null } });
}));
platformDoctorRoutes.get('/:id', validate(uuidParams), wrap(async (req, res) => {
  const result = await S.detail(req.params.id);
  await S.audit(prisma, req.user.id, 'DOCTOR_APPLICATION_VIEWED', { professionalId: req.params.id });
  res.json({ data: result });
}));
async function credential(tx, professionalId, credentialId) {
  const app = await tx.doctorApplication.findUnique({ where: { professionalId }, select: { id: true } });
  if (!app) S.fail('Credential application not found.', 404);
  const locked = await S.lockedApplication(tx, app.id);
  const doc = latestCredentials(locked).find((row) => row.id === credentialId);
  if (!doc) S.fail('Current credential not found.', 404);
  return { app: locked, doc };
}
platformDoctorRoutes.get('/:id/credentials/:credentialId/preview', validate(uuidParams), wrap(async (req, res) => {
  const client = privateStorageClient();
  const url = await prisma.$transaction(async (tx) => {
    const { doc } = await credential(tx, req.params.id, req.params.credentialId);
    if (doc.scanStatus !== 'CLEAN' || !eligibleDocument(doc)) S.fail('Only malware-screened clean credentials can be previewed.');
    await assertPrivateBucket(client, doc.storageBucket);
    const result = await client.storage.from(doc.storageBucket).createSignedUrl(doc.storageKey, 60);
    if (result.error || !result.data?.signedUrl) S.fail('Private preview is unavailable.', 503);
    await S.audit(tx, req.user.id, 'DOCTOR_CREDENTIAL_PREVIEW_ISSUED', { professionalId: req.params.id, credentialId: doc.id });
    return result.data.signedUrl;
  });
  res.json({ data: { url, expiresInSeconds: 60 } });
}));
platformDoctorRoutes.post('/:id/credentials/:credentialId/review', requirePermission('platform.onboarding.approve'), validate(uuidParams), validate(V.reviewSchema), wrap(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const { app, doc } = await credential(tx, req.params.id, req.params.credentialId);
    if (app.professional.userId === req.user.id) S.fail('You cannot review your own credentials.', 403);
    if (!['PENDING', 'REJECTED'].includes(app.professional.verificationStatus) || !app.submittedAt) S.fail('This application is not awaiting review.');
    if (!eligibleDocument(doc)) S.fail('Malware screening must complete before authenticity review.');
    await tx.doctorCredential.update({ where: { id: doc.id }, data: { ...req.body, reviewedBy: req.user.id, reviewedAt: new Date() } });
    await tx.doctorApplication.update({ where: { id: app.id }, data: { stage: 'PENDING_REVIEW' } });
    await S.audit(tx, req.user.id, 'DOCTOR_CREDENTIAL_REVIEWED', { professionalId: req.params.id, credentialId: doc.id, decision: req.body.reviewStatus });
  });
  res.json({ data: await S.detail(req.params.id) });
}));
platformDoctorRoutes.post('/:id/request-changes', requirePermission('platform.onboarding.approve'), validate(uuidParams), validate(V.decisionSchema), wrap(async (req, res) => {
  await prisma.$transaction(async tx => {
    const entry = await tx.doctorApplication.findUnique({ where: { professionalId: req.params.id }, select: { id: true } });
    if (!entry) S.fail('Application not found.', 404);
    const app = await S.lockedApplication(tx, entry.id);
    if (app.professional.userId === req.user.id) S.fail('You cannot review your own application.', 403);
    if (!app.submittedAt || app.professional.verificationStatus !== 'PENDING') S.fail('This application is not awaiting review.');
    await tx.doctorApplication.update({ where: { id: app.id }, data: { stage: 'CHANGES_REQUESTED', submittedAt: null } });
    await tx.professionalProfile.update({ where: { id: req.params.id }, data: { decisionReason: req.body.reason } });
    await tx.notification.create({ data: { userId: app.professional.userId, title: 'Changes requested', message: req.body.reason } });
    await S.audit(tx, req.user.id, 'PROFESSIONAL_CHANGES_REQUESTED', { professionalId: req.params.id });
  });
  res.json({ data: await S.detail(req.params.id) });
}));
platformDoctorRoutes.post('/:id/credentials/:credentialId/retry-scan', validate(uuidParams), wrap(async (req, res) => {
  if (!S.enabled()) S.fail('Scanning is temporarily unavailable.', 503);
  await prisma.$transaction(async (tx) => {
    const { app, doc } = await credential(tx, req.params.id, req.params.credentialId);
    const codes = ['CLOUDMERSIVE_UNAVAILABLE', 'CLOUDMERSIVE_AUTH_FAILED', 'CLOUDMERSIVE_RATE_LIMITED', 'CLOUDMERSIVE_REPLY_INVALID', 'EVIDENCE_DOWNLOAD_FAILED', 'EVIDENCE_CLEAN_UPLOAD_FAILED', 'SCAN_LEASE_EXHAUSTED'];
    if (!['PENDING', 'REJECTED'].includes(app.professional.verificationStatus) || doc.scanStatus !== 'FAILED' || !codes.includes(doc.scanErrorCode) || doc.storageBucket !== 'sabi-hospital-evidence-quarantine' || doc.byteSize > evidenceUploadMaxBytes()) S.fail('Only operational scan failures may be retried. Replace unsafe or oversized documents.');
    await tx.doctorCredential.update({ where: { id: doc.id }, data: { scanStatus: 'PENDING', scanAttempts: 0, scanLeaseToken: null, scanLeaseExpiresAt: null, scanErrorCode: null } });
    await S.audit(tx, req.user.id, 'DOCTOR_SCAN_REQUEUED', { credentialId: doc.id });
  });
  res.status(202).json({ data: await S.detail(req.params.id) });
}));
platformDoctorRoutes.post('/:id/approve', requirePermission('platform.onboarding.approve'), validate(uuidParams), wrap(async (req, res) => {
  await professionals.decide(req.user.id, req.params.id, 'VERIFIED');
  const result = await S.detail(req.params.id);
  const emailSent = await S.sendApproved(result.email);
  await S.audit(prisma, req.user.id, 'DOCTOR_APPROVAL_EMAIL_ATTEMPTED', { professionalId: req.params.id, delivered: emailSent });
  res.json({ data: { ...result, emailSent } });
}));
platformDoctorRoutes.post('/:id/reject', requirePermission('platform.onboarding.approve'), validate(uuidParams), validate(V.decisionSchema), wrap(async (req, res) => {
  await professionals.decide(req.user.id, req.params.id, 'REJECTED', req.body.reason);
  res.json({ data: await S.detail(req.params.id) });
}));
platformDoctorRoutes.post('/:id/resend-approval', requirePermission('platform.onboarding.approve'), createLimiter({ kind: 'doctor-approval-email', max: 3 }), validate(uuidParams), wrap(async (req, res) => {
  const result = await S.detail(req.params.id);
  if (result.status !== 'VERIFIED') S.fail('Doctor approval is required.');
  const emailSent = await S.sendApproved(result.email);
  await S.audit(prisma, req.user.id, 'DOCTOR_APPROVAL_EMAIL_ATTEMPTED', { professionalId: req.params.id, delivered: emailSent });
  res.json({ data: { emailSent } });
}));
doctorOnboardingRoutes.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') return res.status(413).json({ status: 'error', message: 'File exceeds the upload size limit.' });
  return res.status(503).json({ status: 'error', message: 'Doctor onboarding is temporarily unavailable.' });
});
