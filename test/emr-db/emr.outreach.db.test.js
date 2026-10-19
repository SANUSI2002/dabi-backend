// Community outreach against real Postgres with RLS on: the CHW roster from the staff picker, logging
// activities for an active CHW only, entered-in-error, permissions and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const today = () => new Date().toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let chw; let nurse; let doctor; let desk; let bChw;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const log = (who, chwUserId, extra = {}) => as(who).post('/outreach', { chwUserId, activityType: 'Household visit', ward: 'Kirikiri', households: 14, referrals: 2, activityDate: today(), ...extra }, key());

beforeAll(async () => {
  A = await createTenant('outA');
  B = await createTenant('outB');
  chw = await member(A, ['COMMUNITY_HEALTH_WORKER']);
  nurse = await member(A, ['NURSE']);
  doctor = await member(A, ['DOCTOR']);
  desk = await member(A, ['RECEPTIONIST']);
  bChw = await member(B, ['COMMUNITY_HEALTH_WORKER']);
});

describe('community outreach', () => {
  it('lists CHWs on the roster and logs activities for them', async () => {
    const roster = (await as(nurse).get('/staff?permission=outreach.chw')).body.data;
    const ids = (roster.items ?? roster).map((s) => s.userId ?? s.id);
    expect(ids).toContain(chw.userId);
    expect(ids).not.toContain(nurse.userId);

    const own = await log(chw, chw.userId);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.data).toMatchObject({ chwName: expect.any(String), households: 14, referrals: 2, status: 'ACTIVE', recordedByName: expect.any(String) });
    const byNurse = await log(nurse, chw.userId, { activityType: 'Defaulter tracing', households: 6, referrals: 0, notes: 'Two children traced for Penta 3' });
    expect(byNurse.status).toBe(201);

    expect((await log(nurse, nurse.userId)).status).toBe(400); // not a CHW
    expect((await log(nurse, bChw.userId)).status).toBe(400); // another hospital's CHW
    expect((await log(chw, chw.userId, { activityDate: '2999-01-01' })).status).toBe(400);
    expect((await log(chw, chw.userId, { households: -1 })).status).toBe(400);

    const inError = await as(nurse).post(`/outreach/${own.body.data.id}/entered-in-error`, { reason: 'Logged twice' });
    expect(inError.body.data.status).toBe('ENTERED_IN_ERROR');
    expect((await as(nurse).post(`/outreach/${own.body.data.id}/entered-in-error`, { reason: 'Again' })).status).toBe(409);
    const items = (await as(doctor).get('/outreach')).body.data.items.map((a) => a.id);
    expect(items).toContain(byNurse.body.data.id);
    expect(items).not.toContain(own.body.data.id);
  });

  it('keeps the desk out, lets the doctor read only, and keeps hospitals apart', async () => {
    const a = (await log(chw, chw.userId)).body.data;
    expect((await as(desk).get('/outreach')).status).toBe(403);
    expect((await log(doctor, chw.userId)).status).toBe(403);
    expect((await as(bChw).get('/outreach')).body.data.items.find((x) => x.id === a.id)).toBeUndefined();
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrOutreachActivity.updateMany({ where: { id: a.id }, data: { households: 99 } }))).rejects.toThrow();
  });
});
