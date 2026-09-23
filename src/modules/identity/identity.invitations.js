import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Buffer } from 'node:buffer';
import prisma from '../../config/db.js';
import { passwordResetEmailAllowedFor, passwordResetEmailConfigured } from '../auth/auth.email.js';
import { activeMembershipFor, identityError, platformAccessFor } from './identity.service.js';

const INVITE_LIFETIME_MS = 48 * 60 * 60 * 1000;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const normalizeEmail = (value) => value.trim().toLowerCase();
const platformRoles = new Set(['SABI_SUPPORT', 'SABI_COMPLIANCE', 'SABI_PHARMACY_COMPLIANCE']);
const superAdminRoles = new Set([...platformRoles, 'SABI_PLATFORM_ADMIN', 'SABI_SECURITY_ADMIN']);
const tenantRoles = {
  PHARMACY: new Set(['PHARMACY_STAFF']),
  HOSPITAL: new Set(['HOSPITAL_ADMIN', 'FINANCE_OFFICER', 'INVENTORY_OFFICER', 'HR_OFFICER', 'RECEPTIONIST']),
  CLINIC: new Set(['HOSPITAL_ADMIN', 'FINANCE_OFFICER', 'INVENTORY_OFFICER', 'HR_OFFICER', 'RECEPTIONIST']),
  LABORATORY: new Set(['FINANCE_OFFICER']),
  DIAGNOSTIC_CENTRE: new Set(['FINANCE_OFFICER']),
  OTHER: new Set(['HOSPITAL_ADMIN', 'FINANCE_OFFICER', 'HR_OFFICER', 'RECEPTIONIST']),
};

export const allowedPlatformInviteRoles = (context) => [...(context.roles.includes('SABI_SUPER_ADMIN') ? superAdminRoles : platformRoles)];
export const allowedTenantInviteRoles = (context) => [...(tenantRoles[context.organization.type] ?? [])].filter((code) =>
  !['HOSPITAL_ADMIN', 'FINANCE_OFFICER'].includes(code) || context.roles.includes('ORGANISATION_OWNER'));

const publicInvitation = (row) => ({
  id: row.id, email: row.email, scope: row.scope, roleCode: row.roleCode,
  organizationId: row.organizationId, organizationName: row.organization?.organisation?.name ?? row.organization?.pharmacy?.name ?? null,
  expiresAt: row.expiresAt, createdAt: row.createdAt,
  status: row.revokedAt ? 'REVOKED' : row.acceptedAt ? 'ACCEPTED' : row.expiresAt <= new Date() ? 'EXPIRED' : 'PENDING',
});

const invitationSelect = {
  id: true, email: true, scope: true, roleCode: true, organizationId: true, invitedByUserId: true,
  expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true, tokenHash: true,
  organization: { select: { type: true, organisation: { select: { name: true, status: true } }, pharmacy: { select: { name: true, complianceStatus: true } } } },
};

const invitationUrl = (id, token) => `${process.env.CLIENT_URL.replace(/\/$/, '')}/accept-invite/${id}#${token}`;

async function deliverInvitation({ email, scope, roleCode, organizationName, url }) {
  try {
    const response = await globalThis.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.PASSWORD_RESET_EMAIL_FROM,
        to: [email],
        subject: scope === 'PLATFORM' ? 'Invitation to Sabi Command Center' : `Invitation to ${organizationName} on Sabi Health`,
        text: `You have been invited to ${scope === 'PLATFORM' ? 'Sabi Command Center' : organizationName} with the ${roleCode.replaceAll('_', ' ')} role. Accept this invitation within 48 hours. This link can be used once:\n\n${url}\n\nIf you did not expect this invitation, ignore this message.`,
      }),
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`[identity] Invitation email provider returned HTTP ${response.status}.`);
    return response.ok;
  } catch {
    console.error('[identity] Invitation email provider request failed.');
    return false;
  }
}

export async function issueInvitation(actorId, context, scope, organizationId, { email, roleCode }) {
  if (!passwordResetEmailConfigured() || !/^https:\/\/[^/]+$/.test(process.env.CLIENT_URL || '')) throw identityError('INVITATION_EMAIL_UNAVAILABLE', 503);
  const recipient = normalizeEmail(email);
  if (!passwordResetEmailAllowedFor(recipient)) throw identityError('INVITATION_EMAIL_UNAVAILABLE', 503);
  const allowed = scope === 'PLATFORM' ? allowedPlatformInviteRoles(context) : allowedTenantInviteRoles(context);
  if (!allowed.includes(roleCode) || (scope === 'ORGANIZATION' && context.organization.id !== organizationId)) throw identityError('ROLE_SCOPE_DENIED', 403);
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { email: true } });
  if (actor?.email?.toLowerCase() === recipient) throw identityError('SELF_INVITATION_DENIED', 403);
  const existing = await prisma.user.findMany({ where: { email: { equals: recipient, mode: 'insensitive' } }, select: { id: true, accountStatus: true }, take: 2 });
  if (existing.length > 1 || (existing[0] && existing[0].accountStatus !== 'ACTIVE')) throw identityError('IDENTITY_NOT_AVAILABLE', 409);
  if (scope === 'PLATFORM' && existing[0] && await prisma.platformRoleAssignment.findUnique({ where: { userId_roleCode: { userId: existing[0].id, roleCode } } })) throw identityError('INVITATION_CONFLICT', 409);
  if (scope === 'ORGANIZATION' && existing[0] && await prisma.organizationMembership.findUnique({ where: { userId_organizationId: { userId: existing[0].id, organizationId } } })) throw identityError('INVITATION_CONFLICT', 409);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS);
  const invitation = await prisma.$transaction(async (tx) => {
    const row = await tx.identityInvitation.create({ data: { tokenHash: hash(token), email: recipient, scope, organizationId, roleCode, invitedByUserId: actorId, expiresAt }, select: invitationSelect });
    await tx.activityLog.create({ data: { userId: actorId, type: 'IDENTITY_INVITATION_ISSUED', description: 'Staff invitation issued', meta: { invitationId: row.id, scope, organizationId, roleCode } } });
    return row;
  });
  const delivered = await deliverInvitation({ email: recipient, scope, roleCode, organizationName: publicInvitation(invitation).organizationName, url: invitationUrl(invitation.id, token) });
  if (!delivered) {
    await prisma.identityInvitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
    throw identityError('INVITATION_DELIVERY_FAILED', 503);
  }
  await prisma.identityInvitation.updateMany({ where: { email: recipient, scope, organizationId, id: { not: invitation.id }, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  return publicInvitation(invitation);
}

export async function listInvitations(scope, organizationId) {
  const rows = await prisma.identityInvitation.findMany({ where: { scope, organizationId }, select: invitationSelect, orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.map(publicInvitation);
}

export async function revokeInvitation(actorId, id, scope, organizationId) {
  const changed = await prisma.identityInvitation.updateMany({ where: { id, scope, organizationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (changed.count !== 1) throw identityError('INVITATION_NOT_FOUND', 404);
  await prisma.activityLog.create({ data: { userId: actorId, type: 'IDENTITY_INVITATION_REVOKED', description: 'Staff invitation revoked', meta: { invitationId: id, scope, organizationId } } });
  return { id, status: 'REVOKED' };
}

const findValid = async (id, token) => {
  const row = await prisma.identityInvitation.findUnique({ where: { id }, select: invitationSelect });
  const tokenMatches = row?.tokenHash && crypto.timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'));
  if (!tokenMatches || row.acceptedAt || row.revokedAt || row.expiresAt <= new Date()) throw identityError('INVITATION_INVALID', 400);
  return row;
};

export async function previewInvitation(id, token) {
  const row = await findValid(id, token);
  const exists = await prisma.user.findMany({ where: { email: { equals: row.email, mode: 'insensitive' } }, select: { id: true }, take: 1 });
  return { ...publicInvitation(row), existingAccount: exists.length > 0 };
}

export async function acceptInvitation({ id, token, password, fullName }) {
  const row = await findValid(id, token);
  // An invitation is not a permanent grant. A removed inviter cannot leave behind a valid grant.
  if (row.scope === 'PLATFORM') {
    const context = await platformAccessFor(row.invitedByUserId);
    if (!context.permissions.includes('platform.staff.invite') || !allowedPlatformInviteRoles(context).includes(row.roleCode)) throw identityError('INVITATION_INVALID', 400);
  } else {
    const context = await activeMembershipFor(row.invitedByUserId, row.organizationId);
    if (!context.permissions.includes('membership.manage') || !allowedTenantInviteRoles(context).includes(row.roleCode)) throw identityError('INVITATION_INVALID', 400);
  }
  const found = await prisma.user.findMany({ where: { email: { equals: row.email, mode: 'insensitive' } }, select: { id: true, accountStatus: true, password: true }, take: 2 });
  if (found.length > 1 || found[0]?.accountStatus === 'SUSPENDED' || (found[0] && found[0].accountStatus !== 'ACTIVE')) throw identityError('INVITATION_INVALID', 400);
  if (found[0] && !(await bcrypt.compare(password, found[0].password))) throw identityError('INVITATION_INVALID', 400);
  if (!found[0] && !fullName?.trim()) throw identityError('FULL_NAME_REQUIRED', 400);
  if (!found[0] && !/^(?=.{8,128}$)(?=.*\d)(?=.*[^A-Za-z0-9]).+$/.test(password)) throw identityError('PASSWORD_POLICY_FAILED', 400);
  const passwordHash = found[0] ? null : await bcrypt.hash(password, 12);
  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.identityInvitation.updateMany({ where: { id, tokenHash: hash(token), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw identityError('INVITATION_INVALID', 400);
      let userId = found[0]?.id;
      if (!userId) {
        const created = await tx.user.create({ data: { email: row.email, password: passwordHash, full_name: fullName.trim(), patientId: `#SHI${crypto.randomBytes(10).toString('hex')}`, accountStatus: 'ACTIVE', emailVerifiedAt: new Date() }, select: { id: true } });
        userId = created.id;
      } else {
        const current = await tx.user.findUnique({ where: { id: userId }, select: { accountStatus: true, password: true, email: true } });
        if (current?.accountStatus !== 'ACTIVE' || current.password !== found[0].password || current.email?.toLowerCase() !== row.email) throw identityError('INVITATION_INVALID', 400);
        await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
      }
      if (row.scope === 'PLATFORM') {
        await tx.platformRoleAssignment.create({ data: { userId, roleCode: row.roleCode } });
      } else {
        await tx.organizationMembership.create({ data: { userId, organizationId: row.organizationId, status: 'ACTIVE', joinedAt: new Date(), roles: { create: [{ roleCode: row.roleCode }] } } });
      }
      await tx.activityLog.create({ data: { userId, type: 'IDENTITY_INVITATION_ACCEPTED', description: 'Staff invitation accepted', meta: { invitationId: id, scope: row.scope, organizationId: row.organizationId, roleCode: row.roleCode } } });
      return { scope: row.scope, organizationId: row.organizationId, roleCode: row.roleCode };
    });
  } catch (error) {
    if (error?.code === 'P2002') throw identityError('INVITATION_CONFLICT', 409);
    throw error;
  }
}
