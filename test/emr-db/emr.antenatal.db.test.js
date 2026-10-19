// Antenatal care against real Postgres with RLS on: enrolment rules, server-computed EDD and
// gestational age, risk flags, booking labs, entered-in-error, closure, permissions and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let doctor; let nurse; let desk; let admin; let bNurse;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const woman = async (overrides = {}) => (await as(A).post('/patients', newPatient({ sex: 'FEMALE', ...overrides }))).body.data;
const enrol = (who, body) => as(who).post('/antenatal', body, key());

beforeAll(async () => {
  A = await createTenant('ancA');
  B = await createTenant('ancB');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  bNurse = await member(B, ['NURSE']);
});

describe('antenatal enrolment and visits', () => {
  it('works out EDD and gestational age, records visits and raises risk flags from the data', async () => {
    const patient = await woman({ dateOfBirth: '2009-01-15' }); // 16 at the LMP below
    const lmp = daysAgo(20 * 7 + 3);
    const created = await enrol(nurse, { patientId: patient.id, lmp, gravida: 2, parity: 1, bloodGroup: 'O+', bookingHb: 11.2, ttDoses: 1 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const p = created.body.data;
    expect(p).toMatchObject({ status: 'ACTIVE', lmp, gravida: 2, parity: 1, bloodGroup: 'O+', bookingHb: 11.2, gestationalWeeksToday: 20, version: 1 });
    expect(p.edd).toBe(new Date(new Date(`${lmp}T00:00:00Z`).getTime() + 280 * 86_400_000).toISOString().slice(0, 10));
    expect(p.enrolledByName).toEqual(expect.any(String));
    expect(p.riskFlags.map((f) => f.code)).toEqual(['YOUNG_MOTHER']);

    // Gestational age comes from the LMP and the visit date, never from the form.
    const visit = await as(doctor).post(`/antenatal/${p.id}/visits`, { visitDate: daysAgo(3), weightKg: 64.5, systolic: 150, diastolic: 95, hb: 9.4, fetalHeartRate: 172, nextVisitDate: daysAgo(1) }, key());
    expect(visit.status, JSON.stringify(visit.body)).toBe(201);
    const after = visit.body.data;
    expect(after.visits).toHaveLength(1);
    expect(after.visits[0]).toMatchObject({ gestationalWeeks: 20, weightKg: 64.5, systolic: 150, diastolic: 95, hb: 9.4, fetalHeartRate: 172, status: 'ACTIVE' });
    expect(after.riskFlags.map((f) => f.code).sort()).toEqual(['ANAEMIA', 'FETAL_HEART_RATE', 'HYPERTENSION', 'MISSED_VISIT', 'YOUNG_MOTHER']);

    // A wrong visit is marked, not deleted, and stops counting toward risk.
    const marked = await as(nurse).post(`/antenatal/${p.id}/visits/${after.visits[0].id}/entered-in-error`, { reason: 'Recorded on the wrong woman' });
    expect(marked.status).toBe(200);
    expect(marked.body.data.visits[0]).toMatchObject({ status: 'ENTERED_IN_ERROR', errorReason: 'Recorded on the wrong woman', erroredByName: expect.any(String) });
    expect(marked.body.data.riskFlags.map((f) => f.code)).toEqual(['YOUNG_MOTHER']);
    expect((await as(nurse).post(`/antenatal/${p.id}/visits/${after.visits[0].id}/entered-in-error`, { reason: 'Again please' })).status).toBe(409);
  });

  it('refuses impossible enrolments and visits', async () => {
    const patient = await woman();
    expect((await enrol(nurse, { patientId: patient.id, lmp: daysAhead(3), gravida: 1, parity: 0 })).status).toBe(400);
    expect((await enrol(nurse, { patientId: patient.id, lmp: daysAgo(400), gravida: 1, parity: 0 })).status).toBe(400);
    expect((await enrol(nurse, { patientId: patient.id, lmp: daysAgo(70), gravida: 2, parity: 2 })).status).toBe(400);
    const man = (await as(A).post('/patients', newPatient({ sex: 'MALE' }))).body.data;
    expect((await enrol(nurse, { patientId: man.id, lmp: daysAgo(70), gravida: 1, parity: 0 })).status).toBe(400);

    const first = await enrol(nurse, { patientId: patient.id, lmp: daysAgo(70), gravida: 1, parity: 0 });
    expect(first.status).toBe(201);
    const second = await enrol(doctor, { patientId: patient.id, lmp: daysAgo(60), gravida: 1, parity: 0 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PREGNANCY_ALREADY_ACTIVE');

    const id = first.body.data.id;
    const visit = (body) => as(nurse).post(`/antenatal/${id}/visits`, body, key());
    expect((await visit({ visitDate: daysAhead(1) })).status).toBe(400);
    expect((await visit({ visitDate: daysAgo(80) })).status).toBe(400);
    expect((await visit({ visitDate: daysAgo(1), systolic: 120 })).status).toBe(400);
    expect((await visit({ visitDate: daysAgo(1), nextVisitDate: daysAgo(2) })).status).toBe(400);
  });

  it('shows booking bloods ordered since the LMP to staff who may read lab orders', async () => {
    const patient = await woman();
    const p = (await enrol(nurse, { patientId: patient.id, lmp: daysAgo(84), gravida: 1, parity: 0 })).body.data;
    const visit = (await as(doctor).post('/encounters', { patientId: patient.id })).body.data;
    await as(doctor).post(`/encounters/${visit.id}/start`, {}, ifMatch(1));
    const ordered = await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['FBC'], priority: 'ROUTINE', clinicalNotes: 'Booking bloods' });
    expect(ordered.status).toBe(201);

    const seen = (await as(doctor).get('/antenatal?status=ACTIVE')).body.data.items.find((row) => row.id === p.id);
    expect(seen.labs).toEqual([expect.objectContaining({ testName: expect.any(String), status: 'PENDING', result: null })]);
    const adminView = (await as(admin).get('/antenatal')).body.data.items.find((row) => row.id === p.id);
    expect(adminView).toBeDefined();
  });

  it('closes a pregnancy once, with a reason unless she delivered, and then refuses visits', async () => {
    const patient = await woman();
    const p = (await enrol(nurse, { patientId: patient.id, lmp: daysAgo(200), gravida: 3, parity: 2 })).body.data;
    expect((await as(nurse).post(`/antenatal/${p.id}/close`, { status: 'TRANSFERRED_OUT' }, ifMatch(1))).status).toBe(400);
    expect((await as(nurse).post(`/antenatal/${p.id}/close`, { status: 'DELIVERED' }, ifMatch(9))).status).toBe(412);
    const closed = await as(nurse).post(`/antenatal/${p.id}/close`, { status: 'TRANSFERRED_OUT', note: 'Referred to General Hospital for specialist care' }, ifMatch(1));
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: 'TRANSFERRED_OUT', closureNote: 'Referred to General Hospital for specialist care', closedByName: expect.any(String), gestationalWeeksToday: null });
    expect((await as(nurse).post(`/antenatal/${p.id}/visits`, { visitDate: daysAgo(1) }, key())).status).toBe(409);
    // She can be enrolled again for a later pregnancy.
    expect((await enrol(nurse, { patientId: patient.id, lmp: daysAgo(10), gravida: 4, parity: 2 })).status).toBe(201);
  });

  it('keeps the front desk out, other hospitals out, and the database refuses edits', async () => {
    const patient = await woman();
    const p = (await enrol(nurse, { patientId: patient.id, lmp: daysAgo(70), gravida: 1, parity: 0 })).body.data;
    expect((await as(desk).get('/antenatal')).status).toBe(403);
    expect((await enrol(admin, { patientId: patient.id, lmp: daysAgo(70), gravida: 1, parity: 0 })).status).toBe(403);
    expect((await as(bNurse).get('/antenatal')).body.data.items.find((row) => row.id === p.id)).toBeUndefined();
    expect((await as(bNurse).post(`/antenatal/${p.id}/visits`, { visitDate: daysAgo(1) }, key())).status).toBe(404);
    // The enrolment facts never change, and nothing is deleted (column grants on the request role).
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrPregnancy.updateMany({ where: { id: p.id }, data: { gravida: 5 } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.emrPregnancy.deleteMany({ where: { id: p.id } }))).rejects.toThrow();
  });
});
