// Equipment & maintenance against real Postgres with RLS on: the register, a high-priority fault taking
// an asset under repair, resolving it back into service, preventive jobs (one open at a time) and
// logged services, permissions and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let officer; let nurse; let desk; let bOfficer;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const register = async (who = officer) => (await as(who).get('/equipment')).body.data;
const add = (extra = {}) => as(officer).post('/equipment/assets', { tag: `vr-${randomUUID().slice(0, 6)}`, name: 'Vaccine refrigerator', category: 'Cold chain', location: 'EPI room', commissionedOn: daysAgo(900), lastServicedOn: daysAgo(100), serviceIntervalDays: 90, serialNumber: 'HBC-260-01', costMinor: 38000000, ...extra }, key());

beforeAll(async () => {
  A = await createTenant('eqA');
  B = await createTenant('eqB');
  officer = await member(A, ['INVENTORY_OFFICER']);
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  bOfficer = await member(B, ['INVENTORY_OFFICER']);
});

describe('equipment and maintenance', () => {
  it('registers assets and refuses bad dates and duplicate tags', async () => {
    const asset = await add({ tag: 'VR-8890' });
    expect(asset.status, JSON.stringify(asset.body)).toBe(201);
    expect(asset.body.data).toMatchObject({ tag: 'VR-8890', status: 'IN_SERVICE', costMinor: 38000000, lastServicedOn: daysAgo(100) });
    expect((await add({ tag: 'VR-8890' })).body.error.code).toBe('ASSET_TAG_IN_USE');
    expect((await add({ lastServicedOn: daysAgo(1000) })).status).toBe(400);
  });

  it('takes an asset under repair on a high-priority fault and back into service when resolved', async () => {
    const asset = (await add()).body.data;
    const fault = await as(nurse).post('/equipment/faults', { assetId: asset.id, summary: 'Not cooling below 8 °C', priority: 'HIGH' }, key());
    expect(fault.status, JSON.stringify(fault.body)).toBe(201);
    let r = await register();
    expect(r.assets.find((a) => a.id === asset.id).status).toBe('UNDER_REPAIR');
    const job = r.jobs.find((j) => j.id === fault.body.data.jobId);
    expect(job).toMatchObject({ type: 'CORRECTIVE', priority: 'HIGH', status: 'OPEN', reportedByName: expect.any(String) });
    expect((await as(nurse).post(`/equipment/jobs/${job.id}/start`, {}, ifMatch(1))).status).toBe(403);
    expect((await as(officer).post(`/equipment/jobs/${job.id}/start`, {}, ifMatch(1))).body.data.status).toBe('IN_PROGRESS');
    expect((await as(officer).post(`/equipment/jobs/${job.id}/resolve`, { resolution: 'Replaced thermostat' }, ifMatch(2))).body.data.status).toBe('RESOLVED');
    r = await register();
    expect(r.assets.find((a) => a.id === asset.id)).toMatchObject({ status: 'IN_SERVICE', lastServicedOn: today() });
    expect(r.jobs.find((j) => j.id === job.id)).toMatchObject({ resolution: 'Replaced thermostat', resolvedByName: expect.any(String) });
    expect((await as(officer).post(`/equipment/jobs/${job.id}/resolve`, { resolution: 'Again' }, ifMatch(3))).status).toBe(409);
  });

  it('keeps one open preventive job per asset, and a logged service closes it', async () => {
    const asset = (await add()).body.data;
    expect((await as(officer).post(`/equipment/assets/${asset.id}/pm-jobs`)).status).toBe(201);
    expect((await as(officer).post(`/equipment/assets/${asset.id}/pm-jobs`)).body.error.code).toBe('PM_ALREADY_OPEN');
    expect((await as(officer).post(`/equipment/assets/${asset.id}/service`, { note: 'Defrosted and calibrated' })).body.data.lastServicedOn).toBe(today());
    const r = await register();
    expect(r.jobs.filter((j) => j.assetId === asset.id)).toEqual([expect.objectContaining({ type: 'PREVENTIVE', status: 'RESOLVED', resolution: 'Defrosted and calibrated' })]);
    expect((await as(officer).post(`/equipment/assets/${asset.id}/status`, { status: 'RETIRED' }, ifMatch(r.assets.find((a) => a.id === asset.id).version))).body.data.status).toBe('RETIRED');
    expect((await as(nurse).post('/equipment/faults', { assetId: asset.id, summary: 'x', priority: 'LOW' }, key())).status).toBe(409);
  });

  it('keeps the desk out, nurses to reporting, and hospitals apart', async () => {
    const asset = (await add()).body.data;
    expect((await as(desk).get('/equipment')).status).toBe(403);
    expect((await as(nurse).post('/equipment/assets', { tag: 'X1', name: 'x', category: 'IT', location: 'x', commissionedOn: daysAgo(5), lastServicedOn: daysAgo(5), serviceIntervalDays: 30 }, key())).status).toBe(403);
    expect((await register(bOfficer)).assets.find((a) => a.id === asset.id)).toBeUndefined();
    expect((await as(bOfficer).post('/equipment/faults', { assetId: asset.id, summary: 'x', priority: 'LOW' }, key())).status).toBe(404);
    const ctx = { organizationId: A.organizationId, userId: officer.userId };
    await expect(withTenant(ctx, (tx) => tx.emrAsset.updateMany({ where: { id: asset.id }, data: { name: 'Renamed' } }))).rejects.toThrow();
  });
});
