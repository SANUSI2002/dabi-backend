import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = { identityOrganization: { findMany: vi.fn() } };
const identity = { findIdentity: vi.fn(), findPlatformRoles: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: db }));
vi.mock('../src/modules/identity/identity.repository.js', () => identity);
const { default: routes } = await import('../src/modules/platform/platform.routes.js');

const app = express();
app.use('/api/v1/platform', routes);
const userId = '11111111-1111-4111-8111-111111111111';
process.env.JWT_SECRET = 'platform-organizations-route-test';
const authorization = (organizationId) => ({ Authorization: `Bearer ${jwt.sign({ userId, ...(organizationId ? { organizationId } : {}) }, process.env.JWT_SECRET)}` });

beforeEach(() => {
  vi.resetAllMocks();
  identity.findIdentity.mockResolvedValue({ id: userId, accountStatus: 'ACTIVE' });
  identity.findPlatformRoles.mockResolvedValue([{ role: { code: 'SABI_PLATFORM_ADMIN', permissions: [{ permissionCode: 'platform.onboarding.review' }] } }]);
  db.identityOrganization.findMany.mockResolvedValue([{ id: 'org-1', type: 'HOSPITAL', createdAt: new Date('2026-09-23'), organisation: { name: 'Hospital A', status: 'PENDING' }, pharmacy: null }]);
});

describe('platform organization overview', () => {
  it('returns only safe facility fields to a platform reviewer', async () => {
    const response = await request(app).get('/api/v1/platform/organizations').set(authorization());
    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([{ id: 'org-1', type: 'HOSPITAL', name: 'Hospital A', status: 'PENDING', createdAt: '2026-09-23T00:00:00.000Z' }]);
    expect(db.identityOrganization.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 51 }));
  });

  it('rejects patients, tenant-scoped tokens and invalid pagination before querying facilities', async () => {
    expect((await request(app).get('/api/v1/platform/organizations')).status).toBe(401);
    identity.findPlatformRoles.mockResolvedValue([]);
    expect((await request(app).get('/api/v1/platform/organizations').set(authorization())).status).toBe(403);
    identity.findPlatformRoles.mockResolvedValue([{ role: { code: 'SABI_PLATFORM_ADMIN', permissions: [{ permissionCode: 'platform.onboarding.review' }] } }]);
    expect((await request(app).get('/api/v1/platform/organizations').set(authorization('tenant-1'))).status).toBe(403);
    expect((await request(app).get('/api/v1/platform/organizations?page=0').set(authorization())).status).toBe(400);
    expect(db.identityOrganization.findMany).not.toHaveBeenCalled();
  });
});
