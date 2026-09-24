import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const db = vi.hoisted(() => ({
  platformApplication: { findUnique: vi.fn() },
  $transaction: vi.fn(),
  emrPatient: { findMany: vi.fn(), create: vi.fn() },
  activityLog: { create: vi.fn() },
}));
const access = vi.hoisted(() => ({ organizationId: '11111111-1111-4111-8111-111111111111', permissions: ['patient.read', 'patient.register'] }));
vi.mock('../src/config/db.js', () => ({ default: db }));
vi.mock('../src/middleware/authMiddleware.js', () => ({ protect: (req, _res, next) => { req.user = { id: 'user-1' }; next(); } }));
vi.mock('../src/middleware/accessMiddleware.js', () => ({
  requireOrganization: (req, _res, next) => { req.accessContext = { organization: { id: access.organizationId, facilityId: 'facility-1', type: 'HOSPITAL' }, permissions: access.permissions }; next(); },
  requirePermission: (permission) => (req, res, next) => req.accessContext.permissions.includes(permission)
    ? next() : res.status(403).json({ status: 'error', error: { code: 'PERMISSION_DENIED' } }),
}));
const { default: router } = await import('../src/modules/emr/emr.patients.routes.js');
const app = express();
app.use(express.json());
app.use('/api/v1/emr/organizations', router);

const approved = { status: 'APPROVED', setupCompletedAt: new Date(), packageVersion: { status: 'PUBLISHED', moduleKeys: ['emr'] } };
const data = { givenName: 'Synthetic', familyName: 'Patient', dateOfBirth: '2000-01-01', sex: 'UNKNOWN', medicalRecordNumber: 'TEST-001' };
beforeEach(() => {
  vi.resetAllMocks();
  access.organizationId = orgA;
  access.permissions = ['patient.read', 'patient.register'];
  db.platformApplication.findUnique.mockResolvedValue(approved);
  db.$transaction.mockImplementation((work) => work(db));
  db.activityLog.create.mockResolvedValue({ id: 'log-1' });
  process.env.EMR_PATIENT_REGISTRY_ENABLED = 'true';
});
afterEach(() => { delete process.env.EMR_PATIENT_REGISTRY_ENABLED; });

describe('tenant-scoped EMR patient registry', () => {
  it('rejects a cross-tenant path before reading patients', async () => {
    const response = await request(app).get(`/api/v1/emr/organizations/${orgB}/patients`);
    expect(response.status).toBe(403);
    expect(db.platformApplication.findUnique).not.toHaveBeenCalled();
    expect(db.emrPatient.findMany).not.toHaveBeenCalled();
  });

  it('rejects a tenant without completed EMR activation', async () => {
    db.platformApplication.findUnique.mockResolvedValue({ ...approved, setupCompletedAt: null });
    const response = await request(app).get(`/api/v1/emr/organizations/${orgA}/patients`);
    expect(response.status).toBe(403);
    expect(db.emrPatient.findMany).not.toHaveBeenCalled();
  });

  it('stays closed while the clinical test feature is disabled', async () => {
    delete process.env.EMR_PATIENT_REGISTRY_ENABLED;
    const response = await request(app).get(`/api/v1/emr/organizations/${orgA}/patients`);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('EMR_PATIENT_REGISTRY_DISABLED');
    expect(db.emrPatient.findMany).not.toHaveBeenCalled();
  });

  it('enforces patient permissions inside an approved organization', async () => {
    access.permissions = [];
    const response = await request(app).get(`/api/v1/emr/organizations/${orgA}/patients`);
    expect(response.status).toBe(403);
    expect(db.emrPatient.findMany).not.toHaveBeenCalled();
  });

  it('lists only the signed organization and audits the read', async () => {
    db.emrPatient.findMany.mockResolvedValue([]);
    const response = await request(app).get(`/api/v1/emr/organizations/${orgA}/patients?q=TEST`);
    expect(response.status).toBe(200);
    expect(db.emrPatient.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: orgA }) }));
    expect(db.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'EMR_PATIENT_LIST_VIEWED' }) }));
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('registers without accepting tenant id from the body and audits the write', async () => {
    db.emrPatient.create.mockResolvedValue({ id: 'patient-1', ...data });
    const response = await request(app).post(`/api/v1/emr/organizations/${orgA}/patients`).send(data);
    expect(response.status).toBe(201);
    expect(db.emrPatient.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ organizationId: orgA, createdByUserId: 'user-1' }) }));
    expect(db.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'EMR_PATIENT_REGISTERED' }) }));
    const forged = await request(app).post(`/api/v1/emr/organizations/${orgA}/patients`).send({ ...data, organizationId: orgB });
    expect(forged.status).toBe(400);
  });
});
