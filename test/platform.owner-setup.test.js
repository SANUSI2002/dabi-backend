import crypto from 'node:crypto';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const applicationId = '33333333-3333-4333-8333-333333333333';
const reviewerId = '44444444-4444-4444-8444-444444444444';
const organisationId = '55555555-5555-4555-8555-555555555555';
const identityOrganizationId = '66666666-6666-4666-8666-666666666666';
const ownerId = '77777777-7777-4777-8777-777777777777';
const db = {
  $transaction: vi.fn(async (work) => work(db)),
  $queryRaw: vi.fn(),
  platformApplication: { findUnique: vi.fn(), updateMany: vi.fn() },
  user: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  userRole: { upsert: vi.fn() },
  organisation: { create: vi.fn(), findUnique: vi.fn() },
  identityOrganization: { create: vi.fn() },
  organizationMembership: { create: vi.fn(), updateMany: vi.fn() },
  activityLog: { create: vi.fn() },
};
vi.mock('../src/config/db.js', () => ({ default: db }));
const { approveForEmr, completeEmrSetup, previewEmrSetup } = await import('../src/modules/platform/platform.owner-setup.js');
const { requiredEvidence } = await import('../src/modules/platform/platform.approval-readiness.js');
const oldFetch = globalThis.fetch;
const details = {
  owner: { firstName: 'Ada', lastName: 'Test', phone: '+2348000000000' },
  organization: { country: 'Nigeria', state: 'Lagos', facilityType: 'Private Hospital', ownershipType: 'Private', tradingName: 'Hospital A', address: 'One Test Road', city: 'Lagos', officialEmail: 'hospital@example.com', officialPhone: '+2348000000001' },
  regulatoryRegistration: { registrationStatus: 'EXISTING' }, selectedProducts: ['emr'],
};
const completeEvidence = requiredEvidence(details).map((requirementKey) => ({ id: requirementKey, requirementKey, createdAt: new Date(), storageBucket: 'sabi-hospital-evidence-clean', scanStatus: 'CLEAN', reviewStatus: 'VERIFIED', reviewedByUserId: reviewerId, reviewedAt: new Date(), expiresAt: null }));
const fullApplication = { id: applicationId, status: 'UNDER_REVIEW', ownerEmail: 'ada@example.com', emailVerifiedAt: new Date(), details, packageVersionId: 'version-1', packageVersion: { status: 'PUBLISHED', moduleKeys: ['emr'] }, evidence: completeEvidence };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.RESEND_API_KEY = 'test-key';
  process.env.PASSWORD_RESET_EMAIL_FROM = 'no-reply@sabihealth.org';
  process.env.CLIENT_URL = 'https://sabihealth.org';
  globalThis.fetch = vi.fn(async () => ({ ok: true }));
  db.platformApplication.findUnique.mockResolvedValue({ ownerEmail: fullApplication.ownerEmail });
  db.$queryRaw.mockResolvedValue([{ id: applicationId }]);
  db.platformApplication.updateMany.mockResolvedValue({ count: 1 });
  db.user.findMany.mockResolvedValue([]);
  db.user.create.mockResolvedValue({ id: ownerId });
  db.user.updateMany.mockResolvedValue({ count: 1 });
  db.user.findUnique.mockResolvedValue({ accountStatus: 'PENDING', email: 'ada@example.com', password: 'unusable-hash' });
  db.organisation.create.mockResolvedValue({ id: organisationId, type: 'HOSPITAL', name: 'Hospital A' });
  db.organisation.findUnique.mockResolvedValue({ ownerId, identityOrganization: { id: identityOrganizationId } });
  db.identityOrganization.create.mockResolvedValue({ id: identityOrganizationId });
  db.organizationMembership.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => { globalThis.fetch = oldFetch; vi.unstubAllEnvs(); });

describe('approved hospital owner setup', () => {
  it('does not provision an owner or tenant while document workflow is disabled', async () => {
    db.platformApplication.findUnique.mockResolvedValueOnce({ ownerEmail: fullApplication.ownerEmail }).mockResolvedValueOnce(fullApplication);
    await expect(approveForEmr(applicationId, reviewerId)).rejects.toMatchObject({ code: 'APPLICATION_NOT_READY', blockers: ['SECURE_DOCUMENT_WORKFLOW_NOT_CONNECTED'] });
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.organisation.create).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not provision an owner if approval lost the application lock', async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(approveForEmr(applicationId, reviewerId)).rejects.toMatchObject({ code: 'APPLICATION_NOT_READY' });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('provisions a pending owner, sends a one-time link, and activates only after password setup', async () => {
    vi.stubEnv('HOSPITAL_EVIDENCE_INTAKE_ENABLED', 'true');
    vi.stubEnv('EVIDENCE_SCANNER_ENABLED', 'true');
    vi.stubEnv('HOSPITAL_EVIDENCE_REVIEW_ENABLED', 'true');
    db.platformApplication.findUnique.mockResolvedValueOnce({ ownerEmail: fullApplication.ownerEmail }).mockResolvedValueOnce(fullApplication);
    const approval = await approveForEmr(applicationId, reviewerId);
    expect(approval).toMatchObject({ status: 'APPROVED', organizationId: identityOrganizationId, emailSent: true });
    expect(db.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ accountStatus: 'PENDING', email: 'ada@example.com' }) }));
    expect(db.organizationMembership.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }));
    const message = JSON.parse(globalThis.fetch.mock.calls[0][1].body).text;
    expect(message).not.toMatch(/password:\s*\S+/i);
    const link = message.match(/https:\/\/sabihealth\.org\/register\/organization\/setup\/[^\s]+/)[0];
    const token = new URL(link).hash.slice(1);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    expect(db.platformApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ setupTokenHash: hash }) }));
    const pendingSetup = { id: applicationId, status: 'APPROVED', ownerEmail: 'ada@example.com', organizationName: 'Hospital A', approvedOrganisationId: organisationId, setupTokenHash: hash, setupTokenExpiresAt: new Date(Date.now() + 60_000), setupDeadlineAt: new Date(Date.now() + 30 * 24 * 60 * 60_000), setupCompletedAt: null, approvedOrganisation: { owner: { accountStatus: 'PENDING' } } };
    db.platformApplication.findUnique.mockResolvedValue(pendingSetup);
    expect(await previewEmrSetup(applicationId, token)).toMatchObject({ organizationName: 'Hospital A' });
    await expect(previewEmrSetup(applicationId, '0'.repeat(64))).rejects.toMatchObject({ code: 'SETUP_LINK_INVALID' });
    const result = await completeEmrSetup(applicationId, token, 'StrongPass1!');
    expect(result).toEqual({ organizationId: identityOrganizationId, loginPath: '/emr/login' });
    expect(db.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ accountStatus: 'PENDING' }), data: expect.objectContaining({ accountStatus: 'ACTIVE' }) }));
    expect(db.organizationMembership.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'PENDING' }), data: expect.objectContaining({ status: 'ACTIVE' }) }));
  });

  it('links an existing Sabi ID only after the current password is confirmed', async () => {
    vi.stubEnv('HOSPITAL_EVIDENCE_INTAKE_ENABLED', 'true');
    vi.stubEnv('EVIDENCE_SCANNER_ENABLED', 'true');
    vi.stubEnv('HOSPITAL_EVIDENCE_REVIEW_ENABLED', 'true');
    db.user.findMany.mockResolvedValue([{ id: ownerId, accountStatus: 'ACTIVE' }]);
    db.platformApplication.findUnique.mockResolvedValueOnce({ ownerEmail: fullApplication.ownerEmail }).mockResolvedValueOnce(fullApplication);
    await approveForEmr(applicationId, reviewerId);
    expect(db.user.create).not.toHaveBeenCalled();
    const message = JSON.parse(globalThis.fetch.mock.calls[0][1].body).text;
    const token = new URL(message.match(/https:\/\/sabihealth\.org\/register\/organization\/setup\/[^\s]+/)[0]).hash.slice(1);
    db.platformApplication.findUnique.mockResolvedValue({ id: applicationId, status: 'APPROVED', ownerEmail: 'ada@example.com', organizationName: 'Hospital A', approvedOrganisationId: organisationId, setupTokenHash: crypto.createHash('sha256').update(token).digest('hex'), setupTokenExpiresAt: new Date(Date.now() + 60_000), setupDeadlineAt: new Date(Date.now() + 30 * 24 * 60 * 60_000), setupCompletedAt: null, approvedOrganisation: { owner: { accountStatus: 'ACTIVE' } } });
    const bcrypt = await import('bcryptjs');
    db.user.findUnique.mockResolvedValue({ accountStatus: 'ACTIVE', email: 'ada@example.com', password: await bcrypt.default.hash('CurrentPass1!', 4) });
    expect((await previewEmrSetup(applicationId, token)).existingAccount).toBe(true);
    await expect(completeEmrSetup(applicationId, token, 'wrong-password')).rejects.toMatchObject({ code: 'SETUP_PASSWORD_INVALID' });
    expect(db.organizationMembership.updateMany).not.toHaveBeenCalled();
    await completeEmrSetup(applicationId, token, 'CurrentPass1!');
    expect(db.userRole.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_role: { userId: ownerId, role: 'ORGANISATION_OWNER' } } }));
    expect(db.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { emailVerifiedAt: expect.any(Date) } }));
  });
});
