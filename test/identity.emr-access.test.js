import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identityOrganizationId = '11111111-1111-4111-8111-111111111111';
const facilityId = '22222222-2222-4222-8222-222222222222';
const db = { platformApplication: { findUnique: vi.fn() } };
vi.mock('../src/config/db.js', () => ({ default: db }));
const { emrAccess } = await import('../src/modules/identity/identity.controller.js');
const app = express();
app.get('/organizations/:organizationId/emr-access', (req, _res, next) => {
  req.accessContext = { organization: { id: identityOrganizationId, facilityId, type: 'HOSPITAL', name: 'Hospital A' }, roles: ['ORGANISATION_OWNER'] };
  next();
}, emrAccess);

beforeEach(() => vi.resetAllMocks());

describe('server-owned EMR entitlement', () => {
  it('rejects a path for a different tenant without querying its application', async () => {
    const response = await request(app).get('/organizations/other/emr-access');
    expect(response.status).toBe(403);
    expect(db.platformApplication.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a membership without completed, approved EMR setup', async () => {
    db.platformApplication.findUnique.mockResolvedValue({ status: 'APPROVED', setupCompletedAt: null, packageVersion: { status: 'PUBLISHED', moduleKeys: ['emr'] } });
    const response = await request(app).get(`/organizations/${identityOrganizationId}/emr-access`);
    expect(response.status).toBe(403);
    expect(db.platformApplication.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { approvedOrganisationId: facilityId } }));
  });

  it('opens a verified tenant shell without exposing fixture clinical records', async () => {
    db.platformApplication.findUnique.mockResolvedValue({ status: 'APPROVED', setupCompletedAt: new Date(), packageVersion: { status: 'PUBLISHED', moduleKeys: ['emr'] } });
    const response = await request(app).get(`/organizations/${identityOrganizationId}/emr-access`);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ organizationId: identityOrganizationId, facilityId, clinicalApiConnected: false });
    expect(response.body.data).not.toHaveProperty('patients');
  });
});
