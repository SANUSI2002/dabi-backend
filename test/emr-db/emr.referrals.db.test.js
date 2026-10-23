// Referrals against real Postgres with RLS on: the full external lifecycle to a recorded outcome and a
// back-referral, internal referrals, refused transitions, verified-result attachments, permissions and
// isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let doctor; let nurse; let desk; let admin; let scientist; let scientist2; let bDoctor;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const person = async () => (await as(A).post('/patients', newPatient())).body.data;
const refer = (who, patientId, extra = {}) => as(who).post('/referrals', {
  patientId, direction: 'OUT', destination: 'General Hospital, Amuwo', diagnosis: 'Severe pre-eclampsia', reason: 'Complicated Cases', urgency: 'URGENT', clinicalSummary: 'BP 170/112, proteinuria 3+', ...extra,
}, key());

beforeAll(async () => {
  A = await createTenant('refA');
  B = await createTenant('refB');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  scientist = await member(A, ['LAB_SCIENTIST']);
  scientist2 = await member(A, ['LAB_SCIENTIST']);
  bDoctor = await member(B, ['DOCTOR']);
});

describe('referrals', () => {
  it('tracks an external referral to its outcome and opens the back-referral', async () => {
    const p = await person();
    const sent = await refer(nurse, p.id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const r = sent.body.data;
    expect(r).toMatchObject({ status: 'REQUESTED', direction: 'OUT', urgency: 'URGENT', referredByName: expect.any(String), version: 1, feedback: null });

    expect((await as(nurse).post(`/referrals/${r.id}/attend`, {}, ifMatch(1))).status).toBe(409);
    expect((await as(nurse).post(`/referrals/${r.id}/accept`, { receivingClinician: 'Dr. Bello (O&G)' }, ifMatch(1))).body.data).toMatchObject({ status: 'ACCEPTED', receivingClinician: 'Dr. Bello (O&G)' });
    expect((await as(nurse).post(`/referrals/${r.id}/schedule`, { appointmentDate: inDays(2) }, ifMatch(1))).status).toBe(412);
    expect((await as(nurse).post(`/referrals/${r.id}/schedule`, { appointmentDate: inDays(2) }, ifMatch(2))).body.data).toMatchObject({ status: 'SCHEDULED', appointmentDate: inDays(2) });
    expect((await as(nurse).post(`/referrals/${r.id}/attend`, {}, ifMatch(3))).body.data.attendedAt).toEqual(expect.any(String));
    const done = await as(doctor).post(`/referrals/${r.id}/outcome`, { outcome: 'Admitted & managed', note: 'Delivered by CS, stable', by: 'Dr. Bello (O&G)', backReferral: true }, ifMatch(4));
    expect(done.body.data).toMatchObject({ status: 'COMPLETED', feedback: { outcome: 'Admitted & managed', by: 'Dr. Bello (O&G)', backReferral: true } });
    expect((await as(nurse).post(`/referrals/${r.id}/cancel`, {}, ifMatch(5))).status).toBe(409);

    const inbound = (await as(nurse).get(`/referrals?direction=IN&patientId=${p.id}`)).body.data.items;
    expect(inbound).toEqual([expect.objectContaining({ direction: 'IN', status: 'REQUESTED', sourceReferralId: r.id, referredByName: 'Dr. Bello (O&G)' })]);
    expect((await as(nurse).post(`/referrals/${inbound[0].id}/accept`, {}, ifMatch(1))).status).toBe(409);
  });

  it('declines with a reason, cancels internal referrals, and attaches only verified results of the patient', async () => {
    const p = await person();
    const declined = (await refer(doctor, p.id)).body.data;
    expect((await as(doctor).post(`/referrals/${declined.id}/decline`, {}, ifMatch(1))).status).toBe(400);
    expect((await as(doctor).post(`/referrals/${declined.id}/decline`, { reason: 'No ICU bed' }, ifMatch(1))).body.data).toMatchObject({ status: 'DECLINED', declineReason: 'No ICU bed' });

    const internal = (await refer(nurse, p.id, { direction: 'INTERNAL', destination: 'NCD clinic', urgency: 'ROUTINE', reason: 'Other Reasons' })).body.data;
    expect((await as(nurse).post(`/referrals/${internal.id}/cancel`, {}, ifMatch(1))).body.data.status).toBe('CANCELLED');
    expect((await refer(nurse, p.id, { direction: 'IN' })).status).toBe(400);

    const visit = (await as(doctor).post('/encounters', { patientId: p.id })).body.data;
    await as(doctor).post(`/encounters/${visit.id}/start`, {}, ifMatch(1));
    const order = (await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['MP_RDT'] })).body.data;
    const item = order.items[0];
    expect((await refer(doctor, p.id, { attachedLabItemIds: [item.id] })).status).toBe(400); // not verified yet
    await as(nurse).post(`/lab/orders/${order.id}/collect`, {}, ifMatch(1));
    await as(scientist).put(`/lab/orders/${order.id}/items/${item.id}/results`, { results: [{ analyteCode: 'MP', value: 'positive' }] }, ifMatch(1));
    await as(scientist2).post(`/lab/orders/${order.id}/items/${item.id}/verify`, {}, ifMatch(2));
    const withResult = await refer(doctor, p.id, { attachedLabItemIds: [item.id] });
    expect(withResult.body.data.attachments).toEqual([expect.objectContaining({ labItemId: item.id, testName: expect.any(String) })]);
    expect((await refer(doctor, (await person()).id, { attachedLabItemIds: [item.id] })).status).toBe(400); // someone else's result
  });

  it('keeps the desk out, lets the admin read only, and keeps hospitals apart', async () => {
    const r = (await refer(nurse, (await person()).id)).body.data;
    expect((await as(desk).get('/referrals')).status).toBe(403);
    expect((await as(admin).get('/referrals')).status).toBe(200);
    expect((await as(admin).post(`/referrals/${r.id}/accept`, {}, ifMatch(1))).status).toBe(403);
    expect((await as(bDoctor).get('/referrals')).body.data.items.find((x) => x.id === r.id)).toBeUndefined();
    expect((await as(bDoctor).post(`/referrals/${r.id}/accept`, {}, ifMatch(1))).status).toBe(404);
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrReferral.updateMany({ where: { id: r.id }, data: { diagnosis: 'Changed' } }))).rejects.toThrow();
  });
});
