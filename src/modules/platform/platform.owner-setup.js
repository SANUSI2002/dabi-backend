import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import prisma from '../../config/db.js';
import { passwordResetEmailAllowedFor, passwordResetEmailConfigured } from '../auth/auth.email.js';
import { approvalReadiness } from './platform.approval-readiness.js';

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const setupLinkLifetimeMs = 48 * 60 * 60_000;
const setupDeadlineMs = 30 * 24 * 60 * 60_000;
const resendCooldownMs = 10 * 60_000;
const fail = (code, status) => Object.assign(new Error(code), { code, status });
const facilityType = (value) => {
  if (/clinic|primary health/i.test(value)) return 'CLINIC';
  if (/laboratory/i.test(value)) return 'LABORATORY';
  if (/diagnostic/i.test(value)) return 'DIAGNOSTIC_CENTRE';
  if (/hospital|maternity/i.test(value)) return 'HOSPITAL';
  return 'OTHER';
};
const approvalSelect = {
  id: true, status: true, emailVerifiedAt: true, ownerEmail: true, details: true, packageVersionId: true,
  packageVersion: { select: { status: true, moduleKeys: true } },
  evidence: { select: { id: true, requirementKey: true, createdAt: true, storageBucket: true, scanStatus: true, unscannedExceptionByUserId: true, unscannedExceptionAt: true, reviewStatus: true, reviewedByUserId: true, reviewedAt: true, expiresAt: true } },
};

function requireDelivery(email) {
  if (!passwordResetEmailConfigured() || !passwordResetEmailAllowedFor(email)
    || !/^https:\/\/[^/]+$/.test(process.env.CLIENT_URL || '')) throw fail('EMR_SETUP_EMAIL_UNAVAILABLE', 503);
}

async function deliverSetupLink(email, organizationName, applicationId, token) {
  const url = `${process.env.CLIENT_URL.replace(/\/$/, '')}/register/organization/setup/${applicationId}#${token}`;
  try {
    const response = await globalThis.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.PASSWORD_RESET_EMAIL_FROM, to: [email],
        subject: `Sabi EMR access approved for ${organizationName}`,
        text: `We have reviewed and approved the submitted documents for ${organizationName}. You can now activate Sabi EMR access. New Sabi ID users set a password; existing users confirm with their current password. No password is sent by email.\n\nThis single-use link expires in 48 hours. Please complete activation within 30 days of approval. If the link expires, contact Sabi operations for a new one.\n\n${url}\n\nIf you did not apply, contact Sabi support.`,
      }),
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`[platform] EMR setup email provider returned HTTP ${response.status}.`);
    return response.ok;
  } catch {
    console.error('[platform] EMR setup email delivery failed.');
    return false;
  }
}

export async function approveForEmr(applicationId, reviewerId) {
  const initial = await prisma.platformApplication.findUnique({ where: { id: applicationId }, select: { ownerEmail: true } });
  if (!initial) throw fail('APPLICATION_NOT_FOUND', 404);
  requireDelivery(initial.ownerEmail);
  const token = crypto.randomBytes(32).toString('hex');
  const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const now = new Date();
  let approved;
  try {
    approved = await prisma.$transaction(async (tx) => {
      // Serialize approval with applicant uploads so a newer unverified file
      // cannot appear after the evidence snapshot but before activation.
      const locked = await tx.$queryRaw`SELECT id FROM platform_applications WHERE id = ${applicationId} AND status = 'UNDER_REVIEW' FOR UPDATE`;
      if (locked.length !== 1) throw fail('APPLICATION_NOT_READY', 409);
      const application = await tx.platformApplication.findUnique({ where: { id: applicationId }, select: approvalSelect });
      if (!application) throw fail('APPLICATION_NOT_FOUND', 404);
      const readiness = approvalReadiness(application, now);
      if (!readiness.ready) throw Object.assign(fail('APPLICATION_NOT_READY', 409), { blockers: readiness.blockers });
      const existing = await tx.user.findMany({ where: { email: { equals: application.ownerEmail, mode: 'insensitive' } }, select: { id: true, accountStatus: true }, take: 2 });
      if (existing.length > 1 || (existing[0] && existing[0].accountStatus !== 'ACTIVE')) throw fail('OWNER_ACCOUNT_UNAVAILABLE', 409);
      const owner = application.details.owner;
      const organization = application.details.organization;
      const ownerRow = existing[0] ?? await tx.user.create({ data: {
        patientId: `ORG-${crypto.randomUUID()}`, email: application.ownerEmail, password: unusablePassword,
        full_name: `${owner.firstName} ${owner.lastName}`.trim(), phone_number: owner.phone,
        accountStatus: 'PENDING', emailVerifiedAt: application.emailVerifiedAt,
        roles: { create: { role: 'ORGANISATION_OWNER' } },
      }, select: { id: true } });
      const facility = await tx.organisation.create({ data: {
        ownerId: ownerRow.id, type: facilityType(organization.facilityType), name: organization.tradingName,
        address: organization.address, country: organization.country, state: organization.state,
        city: organization.city, contactEmail: organization.officialEmail, contactPhone: organization.officialPhone,
        status: 'VERIFIED', decidedByUserId: reviewerId, decidedAt: now,
      }, select: { id: true, type: true, name: true } });
      const identityOrganization = await tx.identityOrganization.create({ data: { type: facility.type, organisationId: facility.id }, select: { id: true } });
      await tx.organizationMembership.create({ data: {
        userId: ownerRow.id, organizationId: identityOrganization.id, status: 'PENDING',
        roles: { create: { roleCode: 'ORGANISATION_OWNER' } },
      } });
      const deadline = new Date(now.getTime() + setupDeadlineMs);
      const changed = await tx.platformApplication.updateMany({ where: { id: applicationId, status: 'UNDER_REVIEW', approvedOrganisationId: null }, data: {
        status: 'APPROVED', approvedOrganisationId: facility.id, approvedByUserId: reviewerId, approvedAt: now,
        setupTokenHash: tokenHash(token), setupTokenExpiresAt: new Date(Math.min(now.getTime() + setupLinkLifetimeMs, deadline.getTime())),
        setupDeadlineAt: deadline, setupSentAt: now,
      } });
      if (changed.count !== 1) throw fail('APPLICATION_NOT_READY', 409);
      await tx.activityLog.create({ data: { userId: reviewerId, type: 'PLATFORM_APPLICATION_EMR_APPROVED', description: 'Verified hospital approved for EMR owner setup', meta: { applicationId, organisationId: facility.id, packageVersionId: application.packageVersionId } } });
      return { id: applicationId, status: 'APPROVED', organizationName: facility.name, organizationId: identityOrganization.id, setupDeadlineAt: deadline, ownerEmail: application.ownerEmail };
    });
  } catch (error) {
    if (error?.code === 'P2002') throw fail('OWNER_ACCOUNT_UNAVAILABLE', 409);
    throw error;
  }
  const emailSent = await deliverSetupLink(approved.ownerEmail, approved.organizationName, applicationId, token);
  return { id: approved.id, status: approved.status, organizationId: approved.organizationId, setupDeadlineAt: approved.setupDeadlineAt, emailSent };
}

export async function resendEmrSetup(applicationId, reviewerId) {
  const application = await prisma.platformApplication.findUnique({ where: { id: applicationId }, select: {
    id: true, status: true, ownerEmail: true, organizationName: true, setupDeadlineAt: true, setupCompletedAt: true, setupSentAt: true,
  } });
  if (!application || application.status !== 'APPROVED' || application.setupCompletedAt) throw fail('SETUP_NOT_AVAILABLE', 409);
  requireDelivery(application.ownerEmail);
  const now = new Date();
  if (!application.setupDeadlineAt || application.setupDeadlineAt <= now) throw fail('SETUP_DEADLINE_EXPIRED', 409);
  if (application.setupSentAt && application.setupSentAt > new Date(now.getTime() - resendCooldownMs)) throw fail('SETUP_LINK_COOLDOWN', 429);
  const token = crypto.randomBytes(32).toString('hex');
  const changed = await prisma.$transaction(async (tx) => {
    const result = await tx.platformApplication.updateMany({ where: {
      id: applicationId, status: 'APPROVED', setupCompletedAt: null, setupDeadlineAt: { gt: now },
      OR: [{ setupSentAt: null }, { setupSentAt: { lte: new Date(now.getTime() - resendCooldownMs) } }],
    }, data: { setupTokenHash: tokenHash(token), setupTokenExpiresAt: new Date(Math.min(now.getTime() + setupLinkLifetimeMs, application.setupDeadlineAt.getTime())), setupSentAt: now } });
    if (result.count !== 1) throw fail('SETUP_LINK_COOLDOWN', 429);
    await tx.activityLog.create({ data: { userId: reviewerId, type: 'PLATFORM_APPLICATION_SETUP_LINK_REISSUED', description: 'EMR owner setup link reissued', meta: { applicationId } } });
    return result.count;
  });
  if (!changed) throw fail('SETUP_LINK_COOLDOWN', 429);
  const emailSent = await deliverSetupLink(application.ownerEmail, application.organizationName, applicationId, token);
  return { id: applicationId, emailSent, setupDeadlineAt: application.setupDeadlineAt };
}

async function validSetup(applicationId, token) {
  const row = await prisma.platformApplication.findUnique({ where: { id: applicationId }, select: {
    id: true, status: true, ownerEmail: true, organizationName: true, approvedOrganisationId: true,
    setupTokenHash: true, setupTokenExpiresAt: true, setupDeadlineAt: true, setupCompletedAt: true,
    approvedOrganisation: { select: { owner: { select: { accountStatus: true } } } },
  } });
  const now = new Date();
  if (!row || row.status !== 'APPROVED' || !row.approvedOrganisationId || row.setupCompletedAt
    || !['PENDING', 'ACTIVE'].includes(row.approvedOrganisation?.owner.accountStatus)
    || !row.setupTokenHash || row.setupTokenHash !== tokenHash(token)
    || !row.setupTokenExpiresAt || row.setupTokenExpiresAt <= now || !row.setupDeadlineAt || row.setupDeadlineAt <= now) throw fail('SETUP_LINK_INVALID', 400);
  return row;
}

export async function previewEmrSetup(applicationId, token) {
  const row = await validSetup(applicationId, token);
  return { organizationName: row.organizationName, email: row.ownerEmail, setupDeadlineAt: row.setupDeadlineAt, existingAccount: row.approvedOrganisation?.owner.accountStatus === 'ACTIVE' };
}

export async function completeEmrSetup(applicationId, token, password) {
  const row = await validSetup(applicationId, token);
  if (row.approvedOrganisation?.owner.accountStatus === 'PENDING' && !/^(?=.{8,128}$)(?=.*\d)(?=.*[^A-Za-z0-9]).+$/.test(password)) throw fail('PASSWORD_POLICY_FAILED', 400);
  const passwordHash = row.approvedOrganisation?.owner.accountStatus === 'PENDING' ? await bcrypt.hash(password, 12) : null;
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const claimed = await tx.platformApplication.updateMany({ where: {
      id: applicationId, status: 'APPROVED', setupTokenHash: tokenHash(token), setupCompletedAt: null,
      setupTokenExpiresAt: { gt: now }, setupDeadlineAt: { gt: now },
    }, data: { setupTokenHash: null, setupTokenExpiresAt: null, setupCompletedAt: now } });
    if (claimed.count !== 1) throw fail('SETUP_LINK_INVALID', 400);
    const facility = await tx.organisation.findUnique({ where: { id: row.approvedOrganisationId }, select: { ownerId: true, identityOrganization: { select: { id: true } } } });
    if (!facility?.identityOrganization) throw fail('SETUP_LINK_INVALID', 400);
    const current = await tx.user.findUnique({ where: { id: facility.ownerId }, select: { accountStatus: true, email: true, password: true } });
    if (!current || current.email?.toLowerCase() !== row.ownerEmail) throw fail('SETUP_LINK_INVALID', 400);
    if (current.accountStatus === 'PENDING') {
      if (!passwordHash) throw fail('SETUP_LINK_INVALID', 400);
      const user = await tx.user.updateMany({ where: { id: facility.ownerId, accountStatus: 'PENDING', email: row.ownerEmail }, data: { password: passwordHash, accountStatus: 'ACTIVE' } });
      if (user.count !== 1) throw fail('SETUP_LINK_INVALID', 400);
    } else if (current.accountStatus === 'ACTIVE') {
      if (!(await bcrypt.compare(password, current.password))) throw fail('SETUP_PASSWORD_INVALID', 401);
      const user = await tx.user.updateMany({ where: { id: facility.ownerId, accountStatus: 'ACTIVE', password: current.password }, data: { emailVerifiedAt: now } });
      if (user.count !== 1) throw fail('SETUP_LINK_INVALID', 400);
      await tx.userRole.upsert({ where: { userId_role: { userId: facility.ownerId, role: 'ORGANISATION_OWNER' } }, create: { userId: facility.ownerId, role: 'ORGANISATION_OWNER' }, update: {} });
    } else throw fail('SETUP_LINK_INVALID', 400);
    const membership = await tx.organizationMembership.updateMany({ where: { userId: facility.ownerId, organizationId: facility.identityOrganization.id, status: 'PENDING' }, data: { status: 'ACTIVE', joinedAt: now } });
    if (membership.count !== 1) throw fail('SETUP_LINK_INVALID', 400);
    await tx.activityLog.create({ data: { userId: facility.ownerId, type: 'EMR_OWNER_SETUP_COMPLETED', description: 'Approved hospital owner activated Sabi ID', meta: { applicationId, organisationId: row.approvedOrganisationId } } });
    return { organizationId: facility.identityOrganization.id, loginPath: '/emr/login' };
  });
}
