import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import bcrypt from 'bcryptjs';
import prisma from '../../config/db.js';
import { privateStorageClient, assertPrivateBucket, PRIVATE_BUCKETS, uploadPrivateObject } from '../../config/privateStorage.js';
import { evidenceScannerConfigured, evidenceUploadMaxBytes } from '../../config/evidenceScanner.js';
import * as auth from '../auth/auth.model.js';
import { sendEmailVerificationEmail, verificationEmailConfigured, verificationEmailAllowedFor } from '../auth/auth.email.js';
import { approvalBlockers, latestCredentials } from './onboarding.policy.js';
import { PORTAL_PROFESSIONS, credentialRequirements, needsCurrentLicence } from '../professionals/professionCatalog.js';

export const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export const enabled = () => process.env.DOCTOR_REGISTRATION_ENABLED === 'true' && evidenceScannerConfigured();
export const audit = (tx, userId, type, meta) => tx.activityLog.create({ data: { userId, type, description: 'Doctor credential onboarding action', meta } });
const profileInclude = { user: { select: { id: true, email: true, full_name: true, emailVerifiedAt: true, accountStatus: true } }, doctorApplication: { include: { credentials: true } } };
export const doctorPortal = () => {
  const url = process.env.DOCTOR_PORTAL_URL || 'https://doctor.sabihealth.org';
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) fail('Doctor portal email URL is not configured.', 503);
  return url.replace(/\/$/, '');
};
export async function sendVerification(user) {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = await auth.createEmailVerificationToken(user.id, hash(raw), new Date(Date.now() + 86400000));
  const result = await sendEmailVerificationEmail({ email: user.email, verificationUrl: `${doctorPortal()}/verify-email/${user.id}#${raw}` });
  if (result.delivered) await auth.revokeOtherEmailVerificationTokens(user.id, token.id);
  else await auth.revokeEmailVerificationToken(token.id);
  return result.delivered;
}
export async function register(data) {
  if (!enabled() || !verificationEmailConfigured() || !verificationEmailAllowedFor(data.email)) fail('Doctor registration is temporarily unavailable. Please try again later.', 503);
  doctorPortal();
  await assertPrivateBucket(privateStorageClient(), PRIVATE_BUCKETS.hospitalEvidenceQuarantine);
  const { password, ...details } = data;
  const encoded = await bcrypt.hash(password, 12);
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      // Professionals are not patients: give them a collision-free internal identifier (as caregiver and
      // organization accounts do) instead of drawing from the 100,000-value patient number space.
      const user = await tx.user.create({ data: { email: data.email, full_name: `${data.firstName} ${data.lastName}`, phone_number: data.phone,
        password: encoded, accountStatus: 'PENDING', patientId: `PRO-${crypto.randomUUID()}`, roles: { create: { role: 'PROFESSIONAL' } } } });
      const profile = await tx.professionalProfile.create({ data: { userId: user.id, professionType: data.professionType || 'DOCTOR', registrationNumber: data.registrationNumber, specialty: data.specialty, practiceName: data.hospital || null, yearsOfExperience: data.yearsOfExperience,
        doctorApplication: { create: { details, consentVersion: data.consentVersion } } }, include: { doctorApplication: true } });
      await audit(tx, user.id, 'DOCTOR_APPLICATION_CREATED', { professionalId: profile.id, applicationId: profile.doctorApplication.id });
      return { user, application: profile.doctorApplication };
    });
  } catch (error) {
    if (error.code === 'P2002') fail('An account with these details already exists. Sign in or reset your password.', 409);
    throw error;
  }
  const emailSent = await sendVerification(created.user).catch(() => false);
  return { applicationId: created.application.id, userId: created.user.id, email: created.user.email, emailSent, status: 'email_pending', maxUploadBytes: Math.min(evidenceUploadMaxBytes(), 5 * 1024 * 1024) };
}
// Every mutation locks professional then application, in that order. Uploads,
// verification decisions and approval cannot race or deadlock on reversed locks.
export async function lockedApplication(tx, id) {
  const entry = await tx.doctorApplication.findUnique({ where: { id }, select: { professionalId: true } });
  if (!entry) fail('Application not found.', 404);
  await tx.$queryRaw`SELECT id FROM professional_profiles WHERE id = ${entry.professionalId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "DoctorApplication" WHERE id = ${id} FOR UPDATE`;
  return readApplication(tx, id);
}
const readApplication = (db, id) => db.doctorApplication.findUnique({ where: { id }, include: { credentials: true, professional: { include: { user: profileInclude.user } } } });
export function uploadAllowed(application, { userId }) {
  if (!['PENDING', 'REJECTED'].includes(application.professional.verificationStatus)) fail('This application cannot accept changes.', 409);
  if (userId === application.professional.userId && application.professional.user.accountStatus === 'ACTIVE' && application.professional.user.emailVerifiedAt) return;
  fail('Sign in after verifying your email to complete the application.', 403);
}
export const publicCredential = (doc) => ({ id: doc.id, kind: doc.kind, contentType: doc.contentType, byteSize: doc.byteSize, sha256: doc.sha256, scanStatus: doc.scanStatus, scanErrorCode: doc.scanErrorCode, reviewStatus: doc.reviewStatus, sourceName: doc.sourceName, reference: doc.reference, note: doc.note, reviewedAt: doc.reviewedAt, createdAt: doc.createdAt });
export async function updateDetails(id,patch,principal) {
  return prisma.$transaction(async tx => {
    const app=await lockedApplication(tx,id);uploadAllowed(app,principal);
    const details={...app.details,...patch};
    if(app.professional.professionType!=='DOCTOR' && needsCurrentLicence(details) && details.licenceType!=='annual') fail('A dated current licence is required for this discipline.',400);
    await tx.doctorApplication.update({where:{id},data:{details,submittedAt:null,stage:'DRAFT'}});
    // Changed qualification/licensing facts require an independent fresh review.
    await tx.doctorCredential.updateMany({where:{applicationId:id},data:{reviewStatus:'PENDING',sourceName:null,reference:null,note:null,reviewedBy:null,reviewedAt:null}});
    await tx.professionalProfile.update({where:{id:app.professionalId},data:{verificationStatus:'PENDING',decisionReason:null,...(patch.specialty?{specialty:patch.specialty}:{}),...(patch.registrationNumber?{registrationNumber:patch.registrationNumber}:{})}});
    await audit(tx,principal.userId,'PROFESSIONAL_DETAILS_UPDATED',{applicationId:id,fields:Object.keys(patch)});
    return {updated:true};
  });
}
export async function upload(id, kind, bytes, contentType, principal) {
  if (!enabled()) fail('Doctor credential uploads are temporarily unavailable.', 503);
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail('A valid document is required.', 400);
  if (bytes.length > Math.min(evidenceUploadMaxBytes(), 5 * 1024 * 1024)) fail('File exceeds the scanner size limit.', 413);
  const extension = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' }[contentType];
  if (!extension) fail('Only PDF, PNG and JPEG files are accepted.', 415);
  const client = privateStorageClient();
  const acceptUpload = (application) => {
    if (!application) fail('Application not found.', 404);
    uploadAllowed(application, principal);
    if (!credentialRequirements(application.details).some((r) => r.kind === kind)) fail('This document kind is not required for your profession.', 400);
    if (application.credentials.length >= 20) fail('Maximum document revisions reached. Contact Sabi support.', 409);
  };
  // Refuse early without locks so a request that will fail never touches storage.
  acceptUpload(await readApplication(prisma, id));
  // Storage I/O runs outside any transaction: no row lock or pooled connection is held while the
  // bytes travel. The application is then locked and every rule re-checked before the row is written;
  // if anything changed in between, the stored object is removed.
  const stored = await uploadPrivateObject(client, { bucket: PRIVATE_BUCKETS.hospitalEvidenceQuarantine, path: `doctor-applications/${id}/${crypto.randomUUID()}.${extension}`, bytes, contentType });
  try {
    return await prisma.$transaction(async (tx) => {
      const application = await lockedApplication(tx, id);
      acceptUpload(application);
      const doc = await tx.doctorCredential.create({ data: { applicationId: id, kind, storageKey: stored.path, storageBucket: stored.bucket, contentType, byteSize: bytes.length, sha256: hash(bytes) } });
      await tx.doctorApplication.update({ where: { id }, data: { submittedAt: null, stage: 'DRAFT' } });
      await audit(tx, application.professional.userId, 'DOCTOR_CREDENTIAL_UPLOADED', { applicationId: id, credentialId: doc.id, kind });
      return publicCredential(doc);
    });
  } catch (error) {
    await client.storage.from(stored.bucket).remove([stored.path]).catch(() => {});
    throw error;
  }
}
export async function submit(id, principal) {
  if (!enabled()) fail('Doctor submissions are temporarily unavailable.', 503);
  return prisma.$transaction(async (tx) => {
    const app = await lockedApplication(tx, id); uploadAllowed(app, principal);
    if (latestCredentials(app).length !== credentialRequirements(app.details).length) fail('Upload all required credentials before submitting.');
    await tx.doctorApplication.update({ where: { id }, data: { submittedAt: new Date(), stage: 'SUBMITTED' } });
    await tx.professionalProfile.update({ where: { id: app.professionalId }, data: { verificationStatus: 'PENDING', onboardingProgress: 100, decisionReason: null } });
    await audit(tx, app.professional.userId, 'DOCTOR_APPLICATION_SUBMITTED', { applicationId: id });
    return { id, submitted: true };
  });
}
export async function detail(id, userId) {
  const profile = await prisma.professionalProfile.findFirst({ where: { professionType: { in: PORTAL_PROFESSIONS }, ...(id ? { id } : { userId }) }, include: profileInclude });
  if (!profile) fail('Doctor application not found.', 404);
  const app = profile.doctorApplication;
  return { id: profile.id, userId: profile.userId, email: profile.user.email, name: profile.user.full_name, emailVerified: Boolean(profile.user.emailVerifiedAt), status: profile.verificationStatus, decisionReason: profile.decisionReason,
    professionType: profile.professionType, stage: app?.stage, requiredCredentials: credentialRequirements(app?.details), specialty: profile.specialty, registrationNumber: profile.registrationNumber, applicationId: app?.id, details: app?.details, submittedAt: app?.submittedAt,
    credentials: latestCredentials(app).map(publicCredential), blockers: approvalBlockers(profile, app), maxUploadBytes: Math.min(evidenceUploadMaxBytes(), 5 * 1024 * 1024) };
}
export async function approve(tx, profile, adminId) {
  if (profile.userId === adminId) fail('You cannot approve your own doctor profile.', 403);
  const app = await tx.doctorApplication.findUnique({ where: { professionalId: profile.id }, include: { credentials: true } });
  if (!app) fail('A complete credential application is required.');
  await lockedApplication(tx, app.id);
  const current = await tx.professionalProfile.findUnique({ where: { id: profile.id }, include: profileInclude });
  const blockers = approvalBlockers(current, current.doctorApplication);
  if (blockers.length) fail(blockers.join(' '));
}
export async function sendApproved(email) {
  try {
    if (!verificationEmailConfigured() || !verificationEmailAllowedFor(email)) return false;
    const response = await globalThis.fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.PASSWORD_RESET_EMAIL_FROM, to: [email], subject: 'Your Sabi professional credentials have been approved', text: `Sabi operations has reviewed your submitted credentials and approved your professional workspace within your verified scope. Sign in using the email and password you chose at registration. No password is sent by email.\n\n${doctorPortal()}/login\n\nIf you have forgotten your password, use the password-reset link on the sign-in page.` }), signal: globalThis.AbortSignal.timeout(10000) });
    return response.ok;
  } catch { return false; }
}
