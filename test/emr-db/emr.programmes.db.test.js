// Programmes against real Postgres with RLS on: the NCD register (one active enrolment per person and
// condition, blood-pressure checks, due-for-review filter, permissions, isolation) and malaria indicators
// worked out from real visits, diagnoses, lab results and prescriptions.
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

let A; let B; let doctor; let nurse; let desk; let admin; let scientist; let bNurse;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const person = async () => (await as(A).post('/patients', newPatient())).body.data;
const enrol = (who, patientId, extra = {}) => as(who).post('/programmes/ncd', { patientId, condition: 'Essential hypertension', systolic: 150, diastolic: 95, control: 'UNCONTROLLED', nextVisitDate: inDays(30), ...extra }, key());

beforeAll(async () => {
  A = await createTenant('progA');
  B = await createTenant('progB');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  scientist = await member(A, ['LAB_SCIENTIST']);
  bNurse = await member(B, ['NURSE']);
});

describe('NCD register', () => {
  it('enrols once per condition, checks blood pressure, and lists clients due for review', async () => {
    const p = await person();
    const first = await enrol(nurse, p.id, { nextVisitDate: inDays(3) });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({ condition: 'Essential hypertension', systolic: 150, diastolic: 95, control: 'UNCONTROLLED', enrolledByName: expect.any(String), patient: expect.objectContaining({ id: p.id }) });
    expect((await enrol(doctor, p.id)).body.error.code).toBe('NCD_ALREADY_ENROLLED');
    const diabetes = await enrol(doctor, p.id, { condition: 'Type 2 Diabetes Mellitus', systolic: undefined, diastolic: undefined, fastingGlucoseMmol: 9.4, control: 'CONTROLLED', nextVisitDate: inDays(60) });
    expect(diabetes.body.data).toMatchObject({ fastingGlucoseMmol: 9.4, systolic: null });

    expect((await enrol(nurse, (await person()).id, { systolic: 90, diastolic: 120 })).status).toBe(400);
    expect((await enrol(nurse, (await person()).id, { diastolic: undefined })).status).toBe(400);
    expect((await enrol(nurse, (await person()).id, { nextVisitDate: inDays(-5) })).status).toBe(400);

    const due = (await as(nurse).get('/programmes/ncd?dueWithinDays=7')).body.data.items.map((c) => c.id);
    expect(due).toContain(first.body.data.id);
    expect(due).not.toContain(diabetes.body.data.id);
  });

  it('keeps the desk out, lets the admin read only, and keeps hospitals apart', async () => {
    const client = (await enrol(nurse, (await person()).id)).body.data;
    expect((await as(desk).get('/programmes/ncd')).status).toBe(403);
    expect((await as(admin).get('/programmes/ncd')).status).toBe(200);
    expect((await enrol(admin, (await person()).id)).status).toBe(403);
    expect((await as(bNurse).get('/programmes/ncd')).body.data.items.find((c) => c.id === client.id)).toBeUndefined();
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrNcdClient.updateMany({ where: { id: client.id }, data: { control: 'CONTROLLED' } }))).rejects.toThrow();
  });
});

describe('malaria indicators', () => {
  it('counts suspected, tested, positive, confirmed and ACT-treated cases from the record', async () => {
    const before = (await as(nurse).get('/programmes/malaria')).body.data;
    const p = await person();
    const visit = (await as(doctor).post('/encounters', { patientId: p.id, reason: 'Fever and chills for 3 days' })).body.data;
    await as(doctor).post(`/encounters/${visit.id}/start`, {}, ifMatch(1));
    const order = (await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['MP_RDT'] })).body.data;
    await as(nurse).post(`/lab/orders/${order.id}/collect`, {}, ifMatch(1));
    const item = order.items.find((i) => i.testCode === 'MP_RDT');
    const result = await as(scientist).put(`/lab/orders/${order.id}/items/${item.id}/results`, { results: [{ analyteCode: 'MP', value: 'positive' }] }, ifMatch(1));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((await as(doctor).post(`/encounters/${visit.id}/diagnoses`, { codeSystem: 'ICD11', code: '1F40', description: 'Malaria, uncomplicated', rank: 'PRIMARY' })).status).toBe(201);
    expect((await as(doctor).post(`/encounters/${visit.id}/prescriptions`, { items: [{ drugCode: 'AL20_120', dose: 4, doseUnit: 'tablet', frequency: 'BD', durationDays: 3 }] })).status).toBe(201);
    // A second febrile visit: suspected only.
    await as(doctor).post('/encounters', { patientId: (await person()).id, reason: 'High fever' });

    const after = (await as(nurse).get('/programmes/malaria')).body.data;
    expect(after.suspected - before.suspected).toBe(2);
    expect(after.tested - before.tested).toBe(1);
    expect(after.positive - before.positive).toBe(1);
    expect(after.confirmed - before.confirmed).toBe(1);
    expect(after.treatedWithAct - before.treatedWithAct).toBe(1);
    expect(after.cases.find((c) => c.encounterId === visit.id)).toMatchObject({ patient: expect.objectContaining({ id: p.id }), treatment: [expect.stringMatching(/Artemether/)] });
    expect(after.weeklyTrend.at(-1)).toMatchObject({ tested: expect.any(Number), positive: expect.any(Number) });
    expect((await as(bNurse).get('/programmes/malaria')).body.data.cases.find((c) => c.encounterId === visit.id)).toBeUndefined();
    expect((await as(desk).get('/programmes/malaria')).status).toBe(403);
  });
});
