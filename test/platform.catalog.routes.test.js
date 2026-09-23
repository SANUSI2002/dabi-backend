import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
  platformPackage: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  platformPackageVersion: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(async (callback) => callback(db)),
};
const identity = { findIdentity: vi.fn(), findPlatformRoles: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: db }));
vi.mock('../src/modules/identity/identity.repository.js', () => identity);
const { default: privateRoutes, publicPackageRoutes } = await import('../src/modules/platform/platform.catalog.routes.js');
const app = express();
app.use(express.json());
app.use('/api/v1/platform/packages', privateRoutes);
app.use('/api/v1/catalog/packages', publicPackageRoutes);
const userId = '11111111-1111-4111-8111-111111111111';
process.env.JWT_SECRET = 'platform-catalog-route-test';
const authorization = () => ({ Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` });
const version = { id: 'v1', version: 1, status: 'PUBLISHED', currency: 'NGN', monthlyPriceMinor: 100000, annualPriceMinor: 1000000, moduleKeys: ['emr'], publishedAt: new Date('2026-09-24') };
const pkg = { id: 'p1', code: 'CORE', name: 'Core EMR', description: 'Core hospital operations', recommended: false, active: true, branchLimit: 1, storageLimitGb: 10, supportLevel: 'STANDARD', publishedVersion: 1, versions: [version] };

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (callback) => callback(db));
  identity.findIdentity.mockResolvedValue({ id: userId, accountStatus: 'ACTIVE' });
  identity.findPlatformRoles.mockResolvedValue([{ role: { code: 'SABI_PLATFORM_ADMIN', permissions: [{ permissionCode: 'platform.catalog.manage' }] } }]);
  db.platformPackage.findMany.mockResolvedValue([pkg]);
  db.platformPackage.create.mockResolvedValue({ ...pkg, publishedVersion: null, versions: [{ ...version, status: 'DRAFT', publishedAt: null }] });
  db.activityLog.create.mockResolvedValue({});
});

describe('platform package catalog', () => {
  it('exposes only published public offers with integer minor-unit prices', async () => {
    const response = await request(app).get('/api/v1/catalog/packages');
    expect(response.status).toBe(200);
    expect(response.body.data.items[0].versions[0].monthlyPriceMinor).toBe(100000);
    expect(db.platformPackage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { active: true, publishedVersion: { not: null } } }));
  });

  it('requires a platform catalog permission for draft creation', async () => {
    const payload = { code: 'CORE', name: 'Core EMR', description: 'Core hospital operations', branchLimit: 1, storageLimitGb: 10, supportLevel: 'STANDARD', version: { monthlyPriceMinor: 100000, annualPriceMinor: 1000000, currency: 'NGN', moduleKeys: ['emr'] } };
    expect((await request(app).post('/api/v1/platform/packages').send(payload)).status).toBe(401);
    identity.findPlatformRoles.mockResolvedValue([]);
    expect((await request(app).post('/api/v1/platform/packages').set(authorization()).send(payload)).status).toBe(403);
    identity.findPlatformRoles.mockResolvedValue([{ role: { code: 'SABI_PLATFORM_ADMIN', permissions: [{ permissionCode: 'platform.catalog.manage' }] } }]);
    const response = await request(app).post('/api/v1/platform/packages').set(authorization()).send(payload);
    expect(response.status).toBe(201);
    expect(response.body.data.versions[0].status).toBe('DRAFT');
    expect(db.activityLog.create).toHaveBeenCalled();
  });

  it('publishes one immutable version and retires the prior price in one transaction', async () => {
    db.platformPackage.findUnique.mockResolvedValue({ ...pkg, publishedVersion: 1 });
    db.platformPackageVersion.findFirst.mockResolvedValue({ ...version, id: '22222222-2222-4222-8222-222222222222', version: 2, status: 'DRAFT' });
    db.platformPackageVersion.updateMany.mockResolvedValue({ count: 1 });
    db.platformPackage.update.mockResolvedValue({});
    const response = await request(app).post('/api/v1/platform/packages/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222/publish').set(authorization()).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.publishedVersion).toBe(2);
    expect(db.platformPackageVersion.updateMany).toHaveBeenCalledTimes(2);
    expect(db.platformPackage.update).toHaveBeenCalledWith(expect.objectContaining({ data: { publishedVersion: 2 } }));
    expect(db.activityLog.create).toHaveBeenCalled();
  });
});
