// Family planning against real Postgres with RLS on: registration (one active per person) with its
// first visit, resupply, switch, removal, discontinuation, permissions and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let nurse; let desk; let admin; let bNurse;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const woman = async () => (await as(A).post('/patients', newPatient({ sex: 'FEMALE' }))).body.data;
const register = (who, patientId, extra = {}) => as(who).post('/family-planning', { patientId, method: 'Injectable (DMPA-SC)', startDate: day(-30), nextVisitDate: day(60), firstTime: true, ...extra }, key());

beforeAll(async () => {
  A = await createTenant('fpA');
  B = await createTenant('fpB');
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  bNurse = await member(B, ['NURSE']);
});

describe('family planning', () => {
  it('registers once with a first visit, then resupplies, switches and removes', async () => {
    const client = await woman();
    const created = await register(nurse, client.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'ACTIVE', method: 'Injectable (DMPA-SC)', firstTime: true, registeredByName: expect.any(String) });
    expect(created.body.data.visits).toEqual([expect.objectContaining({ visitType: 'NEW_VISIT', method: 'Injectable (DMPA-SC)' })]);
    expect((await register(nurse, client.id)).body.error.code).toBe('FP_CLIENT_ALREADY_ACTIVE');
    const id = created.body.data.id;

    const resupply = await as(nurse).post(`/family-planning/${id}/visits`, { visitType: 'RESUPPLY', nextVisitDate: day(90), notes: 'No side effects' }, ifMatch(1));
    expect(resupply.status, JSON.stringify(resupply.body)).toBe(201);
    expect(resupply.body.data).toMatchObject({ nextVisitDate: day(90), version: 2 });
    expect((await as(nurse).post(`/family-planning/${id}/visits`, { visitType: 'SWITCH_METHOD', method: 'Injectable (DMPA-SC)' }, ifMatch(2))).status).toBe(400);
    expect((await as(nurse).post(`/family-planning/${id}/visits`, { visitType: 'SWITCH_METHOD' }, ifMatch(2))).status).toBe(400);
    const switched = await as(nurse).post(`/family-planning/${id}/visits`, { visitType: 'SWITCH_METHOD', method: 'Implant' }, ifMatch(2));
    expect(switched.body.data.method).toBe('Implant');
    expect((await as(nurse).post(`/family-planning/${id}/visits`, { visitType: 'RESUPPLY' }, ifMatch(2))).status).toBe(412); // stale
    const removed = await as(nurse).post(`/family-planning/${id}/visits`, { visitType: 'REMOVAL' }, ifMatch(3));
    expect(removed.body.data).toMatchObject({ status: 'DISCONTINUED', discontinueReason: 'Removal', nextVisitDate: null, discontinuedByName: expect.any(String) });
    expect(removed.body.data.visits.map((x) => x.visitType)).toEqual(['NEW_VISIT', 'RESUPPLY', 'SWITCH_METHOD', 'REMOVAL']);
    expect((await as(nurse).post(`/family-planning/${id}/visits`, { visitType: 'RESUPPLY' }, ifMatch(4))).status).toBe(409);
    // After discontinuing, she can be registered again.
    expect((await register(nurse, client.id, { method: 'Oral Pill', firstTime: false })).status).toBe(201);
  });

  it('discontinues with a listed reason and refuses impossible dates', async () => {
    const client = await woman();
    expect((await register(nurse, client.id, { startDate: day(2) })).status).toBe(400);
    expect((await register(nurse, client.id, { nextVisitDate: day(-40) })).status).toBe(400);
    const created = (await register(nurse, client.id)).body.data;
    expect((await as(nurse).post(`/family-planning/${created.id}/discontinue`, { reason: 'Because' }, ifMatch(1))).status).toBe(400);
    const stopped = await as(nurse).post(`/family-planning/${created.id}/discontinue`, { reason: 'Wants to conceive' }, ifMatch(1));
    expect(stopped.body.data).toMatchObject({ status: 'DISCONTINUED', discontinueReason: 'Wants to conceive' });
  });

  it('keeps the desk and other hospitals out, and the database refuses edits', async () => {
    const created = (await register(nurse, (await woman()).id)).body.data;
    expect((await as(desk).get('/family-planning')).status).toBe(403);
    expect((await as(admin).get('/family-planning')).status).toBe(200);
    expect((await register(admin, (await woman()).id)).status).toBe(403);
    expect((await as(bNurse).get('/family-planning')).body.data.items.find((c) => c.id === created.id)).toBeUndefined();
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrFpClient.updateMany({ where: { id: created.id }, data: { firstTime: false } }))).rejects.toThrow();
  });
});
