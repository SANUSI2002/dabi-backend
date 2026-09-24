import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const applicationId = '33333333-3333-4333-8333-333333333333';
const userId = '11111111-1111-4111-8111-111111111111';
const db = {
  platformApplication: { updateMany: vi.fn(), findUnique: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(async (callback) => callback(db)),
};
const identity = { findIdentity: vi.fn(), findPlatformRoles: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: db }));
vi.mock('../src/modules/identity/identity.repository.js', () => identity);
const { platformApplicationRoutes } = await import('../src/modules/platform/platform.applications.routes.js');
const app = express();
app.use(express.json());
app.use('/api/v1/platform/applications', platformApplicationRoutes);
process.env.JWT_SECRET = 'platform-review-route-test';
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` });

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (callback) => callback(db));
  identity.findIdentity.mockResolvedValue({ id: userId, accountStatus: 'ACTIVE' });
  identity.findPlatformRoles.mockResolvedValue([{ role: { code: 'SABI_PLATFORM_ADMIN', permissions: [{ permissionCode: 'platform.onboarding.review' }] } }]);
  db.platformApplication.updateMany.mockResolvedValue({ count: 1 });
  db.platformApplication.findUnique.mockResolvedValue({ id: applicationId, status: 'UNDER_REVIEW' });
  db.activityLog.create.mockResolvedValue({});
});

describe('platform hospital review start', () => {
  it('keeps approval readiness private and fail-closed without uploaded evidence', async () => {
    const path = `/api/v1/platform/applications/${applicationId}/approval-readiness`;
    expect((await request(app).get(path)).status).toBe(401);
    identity.findPlatformRoles.mockResolvedValue([]);
    expect((await request(app).get(path).set(auth())).status).toBe(403);
    identity.findPlatformRoles.mockResolvedValue([{ role: { code: 'SABI_PLATFORM_ADMIN', permissions: [{ permissionCode: 'platform.onboarding.review' }] } }]);
    db.platformApplication.findUnique.mockResolvedValue({
      status: 'UNDER_REVIEW', emailVerifiedAt: new Date(),
      details: { organization: { country: 'Nigeria', state: 'Lagos', facilityType: 'Private Hospital', ownershipType: 'Private' }, regulatoryRegistration: { registrationStatus: 'EXISTING' }, selectedProducts: ['emr'] },
      packageVersion: { status: 'PUBLISHED', moduleKeys: ['emr'] }, evidence: [],
    });
    const result = await request(app).get(path).set(auth());
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.data.ready).toBe(false);
    expect(result.body.data.blockers).toContain('MISSING_DOCUMENT:OFFICER_LICENCE');
    expect(result.body.data.blockers).toContain('SECURE_DOCUMENT_WORKFLOW_NOT_CONNECTED');
  });

  it('requires authentication and reviewer permission', async () => {
    expect((await request(app).post(`/api/v1/platform/applications/${applicationId}/start-review`).send({})).status).toBe(401);
    identity.findPlatformRoles.mockResolvedValue([]);
    expect((await request(app).post(`/api/v1/platform/applications/${applicationId}/start-review`).set(auth()).send({})).status).toBe(403);
    expect(db.platformApplication.updateMany).not.toHaveBeenCalled();
  });

  it('atomically starts review only for an email-verified submission and audits the actor', async () => {
    const response = await request(app).post(`/api/v1/platform/applications/${applicationId}/start-review`).set(auth()).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('UNDER_REVIEW');
    expect(db.platformApplication.updateMany).toHaveBeenCalledWith({ where: { id: applicationId, status: 'SUBMITTED', emailVerifiedAt: { not: null } }, data: { status: 'UNDER_REVIEW' } });
    expect(db.activityLog.create).toHaveBeenCalledWith({ data: { userId, type: 'PLATFORM_APPLICATION_REVIEW_STARTED', description: 'Hospital application review started', meta: { applicationId } } });
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it('refuses already-started or unverified applications without an audit write', async () => {
    db.platformApplication.updateMany.mockResolvedValue({ count: 0 });
    const response = await request(app).post(`/api/v1/platform/applications/${applicationId}/start-review`).set(auth()).send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('APPLICATION_NOT_READY');
    expect(db.activityLog.create).not.toHaveBeenCalled();
  });
});
