import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  platformRoleAssignment: { findUnique: vi.fn(), create: vi.fn() },
  organizationMembership: { findUnique: vi.fn(), create: vi.fn() },
  identityInvitation: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
const mail = vi.hoisted(() => ({ passwordResetEmailConfigured: vi.fn(), passwordResetEmailAllowedFor: vi.fn() }));
const access = vi.hoisted(() => ({ activeMembershipFor: vi.fn(), platformAccessFor: vi.fn(), identityError: (code, status) => Object.assign(new Error(code), { code, status }) }));
vi.mock('../src/config/db.js', () => ({ default: db }));
vi.mock('../src/modules/auth/auth.email.js', () => mail);
vi.mock('../src/modules/identity/identity.service.js', () => access);
const { acceptInvitation, allowedPlatformInviteRoles, allowedTenantInviteRoles, issueInvitation, previewInvitation } = await import('../src/modules/identity/identity.invitations.js');

const id = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const token = 'a'.repeat(64);

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CLIENT_URL = 'https://sabihealth.org';
  process.env.RESEND_API_KEY = 'test-only-key';
  process.env.PASSWORD_RESET_EMAIL_FROM = 'no-reply@sabihealth.org';
  mail.passwordResetEmailConfigured.mockReturnValue(true);
  mail.passwordResetEmailAllowedFor.mockReturnValue(true);
  db.$transaction.mockImplementation((work) => work(db));
  db.user.findUnique.mockResolvedValue({ email: 'admin@sabihealth.org' });
  db.user.findMany.mockResolvedValue([]);
  db.platformRoleAssignment.findUnique.mockResolvedValue(null);
  db.organizationMembership.findUnique.mockResolvedValue(null);
  db.identityInvitation.updateMany.mockResolvedValue({ count: 1 });
  db.identityInvitation.create.mockImplementation(async ({ data }) => ({ ...data, id, createdAt: new Date(), acceptedAt: null, revokedAt: null, organization: null }));
  db.activityLog.create.mockResolvedValue({});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

describe('staff invitation boundaries', () => {
  it('keeps platform admin grants below admin/security privilege', async () => {
    const context = { roles: ['SABI_PLATFORM_ADMIN'], permissions: ['platform.staff.invite'] };
    expect(allowedPlatformInviteRoles(context)).not.toContain('SABI_PLATFORM_ADMIN');
    await expect(issueInvitation(id, context, 'PLATFORM', null, { email: 'new@example.test', roleCode: 'SABI_PLATFORM_ADMIN' })).rejects.toMatchObject({ code: 'ROLE_SCOPE_DENIED' });
    expect(db.identityInvitation.create).not.toHaveBeenCalled();
  });

  it('denies cross-tenant invitations and clinical roles', async () => {
    const context = { organization: { id: organizationId, type: 'HOSPITAL' }, roles: ['HOSPITAL_ADMIN'] };
    expect(allowedTenantInviteRoles(context)).not.toContain('DOCTOR');
    await expect(issueInvitation(id, context, 'ORGANIZATION', 'another-organization', { email: 'new@example.test', roleCode: 'RECEPTIONIST' })).rejects.toMatchObject({ code: 'ROLE_SCOPE_DENIED' });
    await expect(issueInvitation(id, context, 'ORGANIZATION', organizationId, { email: 'new@example.test', roleCode: 'DOCTOR' })).rejects.toMatchObject({ code: 'ROLE_SCOPE_DENIED' });
    expect(db.identityInvitation.create).not.toHaveBeenCalled();
  });

  it('stores only the hash, emails a one-use URL and audits without placing the token in the response', async () => {
    const result = await issueInvitation(id, { roles: ['SABI_PLATFORM_ADMIN'] }, 'PLATFORM', null, { email: ' NEW@EXAMPLE.TEST ', roleCode: 'SABI_SUPPORT' });
    const stored = db.identityInvitation.create.mock.calls[0][0].data;
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    const raw = body.text.match(/#([a-f0-9]{64})/)[1];
    expect(body.text).toContain(`https://sabihealth.org/accept-invite/${id}#`);
    expect(stored.tokenHash).not.toBe(raw);
    expect(stored.email).toBe('new@example.test');
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(db.activityLog.create).toHaveBeenCalled();
  });

  it('rejects expired or used tokens before disclosing invitation details', async () => {
    const hash = (await import('crypto')).createHash('sha256').update(token).digest('hex');
    db.identityInvitation.findUnique.mockResolvedValue({ id, tokenHash: hash, expiresAt: new Date(Date.now() - 1), acceptedAt: null, revokedAt: null });
    await expect(previewInvitation(id, token)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    db.identityInvitation.findUnique.mockResolvedValue({ id, tokenHash: hash, expiresAt: new Date(Date.now() + 1000), acceptedAt: new Date(), revokedAt: null });
    await expect(acceptInvitation({ id, token, password: 'anything' })).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  it('does not assign an existing Sabi ID role without its password', async () => {
    const hash = (await import('crypto')).createHash('sha256').update(token).digest('hex');
    db.identityInvitation.findUnique.mockResolvedValue({ id, tokenHash: hash, scope: 'PLATFORM', roleCode: 'SABI_SUPPORT', organizationId: null, invitedByUserId: id, email: 'person@example.test', expiresAt: new Date(Date.now() + 10000), acceptedAt: null, revokedAt: null });
    access.platformAccessFor.mockResolvedValue({ roles: ['SABI_PLATFORM_ADMIN'], permissions: ['platform.staff.invite'] });
    db.user.findMany.mockResolvedValue([{ id: 'existing', accountStatus: 'ACTIVE', password: await bcrypt.hash('correct-password', 4) }]);
    await expect(acceptInvitation({ id, token, password: 'wrong-password' })).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    expect(db.platformRoleAssignment.create).not.toHaveBeenCalled();
  });

  it('claims a new recipient once and grants the requested tenant role only after acceptance', async () => {
    const hash = (await import('crypto')).createHash('sha256').update(token).digest('hex');
    db.identityInvitation.findUnique.mockResolvedValue({ id, tokenHash: hash, scope: 'ORGANIZATION', roleCode: 'RECEPTIONIST', organizationId, invitedByUserId: id, email: 'person@example.test', expiresAt: new Date(Date.now() + 10000), acceptedAt: null, revokedAt: null });
    access.activeMembershipFor.mockResolvedValue({ organization: { id: organizationId, type: 'HOSPITAL' }, roles: ['ORGANISATION_OWNER'], permissions: ['membership.manage'] });
    db.identityInvitation.updateMany.mockResolvedValue({ count: 1 });
    db.user.create.mockResolvedValue({ id: 'created-user' });
    db.organizationMembership.create.mockResolvedValue({});
    const accepted = await acceptInvitation({ id, token, password: 'StrongPassword1!', fullName: 'New Member' });
    expect(accepted).toMatchObject({ scope: 'ORGANIZATION', organizationId, roleCode: 'RECEPTIONIST' });
    expect(db.identityInvitation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ acceptedAt: null, revokedAt: null }) }));
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ email: 'person@example.test', accountStatus: 'ACTIVE' });
    expect(db.organizationMembership.create.mock.calls[0][0].data).toMatchObject({ userId: 'created-user', organizationId, status: 'ACTIVE' });
    expect(db.platformRoleAssignment.create).not.toHaveBeenCalled();
  });
});
