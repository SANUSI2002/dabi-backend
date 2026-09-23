import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = {
  findIdentity: vi.fn(),
  listMemberships: vi.fn(),
  findActiveMembership: vi.fn(),
  findPlatformRoles: vi.fn(),
  transaction: vi.fn(),
  findUsersByEmail: vi.fn(),
  findProfessionalProfile: vi.fn(),
  professionalProfileFor: vi.fn(),
  findOrganizationMembership: vi.fn(),
  createMembership: vi.fn(),
  listOrganizationMemberships: vi.fn(),
  findManagedMembership: vi.fn(),
  revokeMembership: vi.fn(),
  revokeLegacyPharmacyStaff: vi.fn(),
  findMembershipById: vi.fn(),
  acceptMembership: vi.fn(),
  auditMembership: vi.fn(),
};
const authModel = { findUserById: vi.fn() };
vi.mock('../src/modules/identity/identity.repository.js', () => repository);
vi.mock('../src/modules/auth/auth.model.js', () => authModel);

const { default: authRoutes } = await import('../src/modules/auth/auth.routes.js');
const { protect } = await import('../src/middleware/authMiddleware.js');
const { requireOrganization, requirePermission, requirePlatform } = await import('../src/middleware/accessMiddleware.js');

const userId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const organizationId = '33333333-3333-4333-8333-333333333333';
const otherOrganizationId = '44444444-4444-4444-8444-444444444444';
const targetId = '55555555-5555-4555-8555-555555555555';
process.env.JWT_SECRET = 'identity-foundation-test-secret';

const membership = (status = 'ACTIVE', roles = ['ORGANISATION_OWNER']) => ({
  id: memberId,
  userId,
  status,
  joinedAt: new Date(),
  organization: {
    id: organizationId,
    type: 'HOSPITAL',
    organisation: { id: '66666666-6666-4666-8666-666666666666', name: 'Hospital A', status: 'VERIFIED' },
    pharmacy: null,
  },
  roles: roles.map((code) => ({
    role: {
      code,
      scope: 'ORGANIZATION',
      permissions: (code === 'ORGANISATION_OWNER'
        ? ['organization.read', 'membership.read', 'membership.manage']
        : ['patient.read']).map((permissionCode) => ({ permissionCode })),
    },
  })),
});

const app = express();
app.use(express.json());
app.use('/api/v1/auth', authRoutes);
app.get('/tenant-probe', protect, requireOrganization, requirePermission('patient.read'), (req, res) => res.json({ organizationId: req.accessContext.organization.id }));
app.get('/platform-probe', protect, requirePlatform, requirePermission('platform.security.view'), (req, res) => res.json({ granted: true }));
const token = (id = userId, orgId) => jwt.sign({ userId: id, ...(orgId ? { organizationId: orgId } : {}) }, process.env.JWT_SECRET);
const bearer = (id = userId, orgId) => ({ Authorization: `Bearer ${token(id, orgId)}` });

beforeEach(() => {
  vi.resetAllMocks();
  repository.findIdentity.mockResolvedValue({ id: userId, accountStatus: 'ACTIVE' });
  repository.listMemberships.mockResolvedValue([membership()]);
  repository.findActiveMembership.mockImplementation(async (id, orgId) => id === userId && orgId === organizationId ? membership() : null);
  repository.findPlatformRoles.mockResolvedValue([]);
  repository.transaction.mockImplementation((work) => work({}));
  repository.findUsersByEmail.mockResolvedValue([{ id: targetId, accountStatus: 'ACTIVE' }]);
  repository.findProfessionalProfile.mockResolvedValue({ professionType: 'DOCTOR', verificationStatus: 'VERIFIED' });
  repository.professionalProfileFor.mockResolvedValue({ professionType: 'DOCTOR', verificationStatus: 'VERIFIED' });
  repository.findOrganizationMembership.mockResolvedValue(null);
  repository.createMembership.mockResolvedValue({ id: '77777777-7777-4777-8777-777777777777', status: 'PENDING' });
  repository.auditMembership.mockResolvedValue({});
  repository.findMembershipById.mockResolvedValue({ id: memberId, status: 'PENDING', organizationId, organization: { type: 'HOSPITAL' }, roles: [{ roleCode: 'DOCTOR' }] });
  repository.acceptMembership.mockResolvedValue({ count: 1 });
  repository.findManagedMembership.mockResolvedValue({ id: memberId, userId: targetId, status: 'ACTIVE', roles: [{ roleCode: 'DOCTOR' }] });
  repository.revokeMembership.mockResolvedValue({ count: 1 });
  repository.listOrganizationMemberships.mockResolvedValue([]);
  authModel.findUserById.mockResolvedValue({ id: userId, email: 'owner@example.test', patientId: 'ORG-1', profile: null, roles: [{ role: 'ORGANISATION_OWNER' }], accountStatus: 'ACTIVE' });
});

describe('central identity foundation', () => {
  it('lists membership and issues a tenant token only after a current membership check', async () => {
    const list = await request(app).get('/api/v1/auth/organizations').set(bearer());
    expect(list.status).toBe(200);
    expect(list.body.data.items[0]).toMatchObject({ organization: { id: organizationId, name: 'Hospital A' }, roles: ['ORGANISATION_OWNER'] });
    const selected = await request(app).post('/api/v1/auth/organizations/switch').set(bearer()).send({ organizationId });
    expect(selected.status).toBe(200);
    expect(jwt.verify(selected.body.accessToken, process.env.JWT_SECRET).organizationId).toBe(organizationId);
    const me = await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${selected.body.accessToken}` });
    expect(me.status).toBe(200);
    expect(me.body.currentOrganization.organization.id).toBe(organizationId);
    const foreign = await request(app).post('/api/v1/auth/organizations/switch').set(bearer()).send({ organizationId: otherOrganizationId });
    expect(foreign.status).toBe(403);
    repository.findActiveMembership.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${selected.body.accessToken}` })).status).toBe(403);
  });

  it('enforces tenant permission from the database and denies forged or suspended contexts', async () => {
    expect((await request(app).get('/tenant-probe').set(bearer(userId, organizationId))).status).toBe(403);
    repository.findActiveMembership.mockResolvedValueOnce(membership('ACTIVE', ['DOCTOR']));
    expect((await request(app).get('/tenant-probe').set(bearer(userId, organizationId))).body.organizationId).toBe(organizationId);
    expect((await request(app).get('/tenant-probe').set(bearer(userId, otherOrganizationId))).status).toBe(403);
    repository.findActiveMembership.mockResolvedValueOnce(membership('SUSPENDED', ['DOCTOR']));
    expect((await request(app).get('/tenant-probe').set(bearer(userId, organizationId))).status).toBe(403);
    expect((await request(app).get('/tenant-probe').set(bearer())).status).toBe(403);
  });

  it('keeps platform roles separate and rejects inactive identities', async () => {
    repository.findPlatformRoles.mockResolvedValue([{ role: { code: 'SABI_SECURITY_ADMIN', permissions: [{ permissionCode: 'platform.security.view' }] } }]);
    expect((await request(app).get('/api/v1/auth/platform-assignment').set(bearer())).body.data).toEqual({ assigned: true });
    expect((await request(app).get('/api/v1/auth/platform-assignment').set(bearer(userId, organizationId))).status).toBe(403);
    expect((await request(app).get('/platform-probe').set(bearer())).status).toBe(200);
    expect((await request(app).get('/platform-probe').set(bearer(userId, organizationId))).status).toBe(403);
    repository.findIdentity.mockResolvedValue({ id: userId, accountStatus: 'SUSPENDED' });
    expect((await request(app).get('/platform-probe').set(bearer())).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/organizations/switch').set(bearer()).send({ organizationId })).status).toBe(401);
  });

  it('does not expose a platform assignment to a patient account', async () => {
    expect((await request(app).get('/api/v1/auth/platform-assignment').set(bearer())).status).toBe(403);
  });

  it('invites an existing identity only to the selected organization with allowed roles', async () => {
    const url = `/api/v1/auth/organizations/${organizationId}/memberships`;
    const invite = await request(app).post(url).set(bearer(userId, organizationId)).send({ email: 'doctor@example.test', roleCodes: ['DOCTOR'] });
    expect(invite.status).toBe(201);
    expect(repository.createMembership).toHaveBeenCalledWith(expect.anything(), targetId, organizationId, ['DOCTOR']);
    expect((await request(app).post(url).set(bearer(userId, organizationId)).send({ email: 'doctor@example.test', roleCodes: ['SABI_SUPER_ADMIN'] })).status).toBe(403);
    repository.findProfessionalProfile.mockResolvedValue({ professionType: 'DOCTOR', verificationStatus: 'PENDING' });
    expect((await request(app).post(url).set(bearer(userId, organizationId)).send({ email: 'doctor@example.test', roleCodes: ['DOCTOR'] })).status).toBe(403);
    repository.findProfessionalProfile.mockResolvedValue({ professionType: 'DOCTOR', verificationStatus: 'VERIFIED' });
    expect((await request(app).post(`/api/v1/auth/organizations/${otherOrganizationId}/memberships`).set(bearer(userId, organizationId)).send({ email: 'doctor@example.test', roleCodes: ['DOCTOR'] })).status).toBe(403);
    repository.findOrganizationMembership.mockResolvedValue({ id: memberId });
    expect((await request(app).post(url).set(bearer(userId, organizationId)).send({ email: 'doctor@example.test', roleCodes: ['DOCTOR'] })).status).toBe(409);
  });

  it('accepts own pending membership and revokes another member without deleting history', async () => {
    const accepted = await request(app).post(`/api/v1/auth/memberships/${memberId}/accept`).set(bearer());
    expect(accepted.status).toBe(200);
    expect(repository.acceptMembership).toHaveBeenCalledWith(expect.anything(), memberId, userId);
    const revoked = await request(app).post(`/api/v1/auth/organizations/${organizationId}/memberships/${memberId}/revoke`).set(bearer(userId, organizationId));
    expect(revoked.status).toBe(200);
    expect(repository.revokeMembership).toHaveBeenCalledWith(expect.anything(), memberId, organizationId);
    expect(repository.revokeLegacyPharmacyStaff).toHaveBeenCalledWith(expect.anything(), organizationId, targetId);
    repository.findManagedMembership.mockResolvedValue({ id: memberId, userId, status: 'ACTIVE' });
    expect((await request(app).post(`/api/v1/auth/organizations/${organizationId}/memberships/${memberId}/revoke`).set(bearer(userId, organizationId))).status).toBe(404);
    repository.findMembershipById.mockResolvedValue({ id: memberId, status: 'PENDING', organizationId, organization: { type: 'PHARMACY' }, roles: [{ roleCode: 'PHARMACIST' }] });
    expect((await request(app).post(`/api/v1/auth/memberships/${memberId}/accept`).set(bearer())).status).toBe(403);
  });
});
