// Patient transfers against real Postgres with RLS on: transfer out (one pending per patient) to
// completion with records handed over, inbound transfers by name, cancellation, permissions, isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let nurse; let desk; let admin; let pharmacist; let bDesk;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const person = async () => (await as(A).post('/patients', newPatient())).body.data;
const out = (who, patientId, extra = {}) => as(who).post('/transfers', { direction: 'OUT', patientId, facility: 'PHC Kirikiri', reason: 'Relocation', summary: 'HTN on amlodipine 5 mg', ...extra }, key());

beforeAll(async () => {
  A = await createTenant('trA');
  B = await createTenant('trB');
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  pharmacist = await member(A, ['PHARMACIST']);
  bDesk = await member(B, ['RECEPTIONIST']);
});

describe('patient transfers', () => {
  it('transfers a patient out once at a time and completes with the records handed over', async () => {
    const p = await person();
    const sent = await out(desk, p.id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const t = sent.body.data;
    expect(t).toMatchObject({ direction: 'OUT', status: 'PENDING', recordsSent: false, patientName: `${p.givenName} ${p.familyName}`, initiatedByName: expect.any(String) });
    expect((await out(nurse, p.id)).body.error.code).toBe('TRANSFER_ALREADY_PENDING');
    expect((await as(nurse).post(`/transfers/${t.id}/complete`, {}, ifMatch(9))).status).toBe(412);
    const done = await as(nurse).post(`/transfers/${t.id}/complete`, {}, ifMatch(1));
    expect(done.body.data).toMatchObject({ status: 'COMPLETED', recordsSent: true, completedByName: expect.any(String) });
    expect((await as(nurse).post(`/transfers/${t.id}/cancel`, {}, ifMatch(2))).status).toBe(409);
    expect((await out(nurse, p.id)).status).toBe(201); // a new transfer once the last one is done
  });

  it('records inbound transfers by name and cancels pending ones', async () => {
    const inbound = await as(desk).post('/transfers', { direction: 'IN', patientName: 'Halima Musa', facility: 'General Hospital, Ikorodu', reason: 'Catchment reassignment' }, key());
    expect(inbound.body.data).toMatchObject({ direction: 'IN', patientId: null, patientName: 'Halima Musa', recordsSent: true });
    expect((await as(desk).post('/transfers', { direction: 'IN', facility: 'X', reason: 'Relocation' }, key())).status).toBe(400);
    expect((await as(desk).post('/transfers', { direction: 'OUT', patientName: 'No record', facility: 'X', reason: 'Relocation' }, key())).status).toBe(400);
    expect((await as(desk).post(`/transfers/${inbound.body.data.id}/cancel`, {}, ifMatch(1))).body.data.status).toBe('CANCELLED');
    expect((await as(desk).get('/transfers?direction=IN')).body.data.items.map((x) => x.id)).toContain(inbound.body.data.id);
  });

  it('keeps other roles out, lets the admin read only, and keeps hospitals apart', async () => {
    const t = (await out(nurse, (await person()).id)).body.data;
    expect((await as(pharmacist).get('/transfers')).status).toBe(403);
    expect((await as(admin).get('/transfers')).status).toBe(200);
    expect((await as(admin).post(`/transfers/${t.id}/complete`, {}, ifMatch(1))).status).toBe(403);
    expect((await as(bDesk).get('/transfers')).body.data.items.find((x) => x.id === t.id)).toBeUndefined();
    expect((await as(bDesk).post(`/transfers/${t.id}/complete`, {}, ifMatch(1))).status).toBe(404);
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrPatientTransfer.updateMany({ where: { id: t.id }, data: { facility: 'Changed' } }))).rejects.toThrow();
  });
});
