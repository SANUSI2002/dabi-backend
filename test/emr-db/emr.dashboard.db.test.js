// The workspace dashboard against real Postgres with RLS on: real figures, per-role sections.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
const startOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.toISOString(); };
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const board = (who, query = `?since=${encodeURIComponent(startOfDay())}&monthStart=${encodeURIComponent(startOfMonth())}`) => as(who).get(`/dashboard${query}`);

let A; let B; let doctor; let otherDoctor; let nurse; let scientist; let scientist2; let finance; let pharmacist; let bDoctor;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

beforeAll(async () => {
  A = await createTenant('boardA');
  B = await createTenant('boardB');
  doctor = await member(A, ['DOCTOR']);
  otherDoctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  scientist = await member(A, ['LAB_SCIENTIST']);
  scientist2 = await member(A, ['LAB_SCIENTIST']);
  finance = await member(A, ['FINANCE_OFFICER']);
  pharmacist = await member(A, ['PHARMACIST']);
  bDoctor = await member(B, ['DOCTOR']);

  // One visit: waiting in the queue, a draft note, FBC resulted critical (not yet communicated),
  // MP RDT verified (to acknowledge), a lipid profile still pending, and a prescription to review.
  const patient = (await as(A).post('/patients', newPatient({ givenName: 'Ngozi', familyName: 'Obi' }))).body.data;
  const visit = (await as(doctor).post('/encounters', { patientId: patient.id, reason: 'Dizziness' })).body.data;
  await as(doctor).post(`/encounters/${visit.id}/notes`, { kind: 'CONSULTATION', subjective: 'Dizzy on standing' });
  const order = (await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['FBC', 'MP_RDT', 'LIPID'] })).body.data;
  await as(nurse).post(`/lab/orders/${order.id}/collect`, {}, ifMatch(1));
  const itemUrl = (code) => `/lab/orders/${order.id}/items/${order.items.find((i) => i.testCode === code).id}`;
  expect((await as(scientist).put(`${itemUrl('FBC')}/results`, { results: [{ analyteCode: 'HB', value: 6.2 }, { analyteCode: 'PCV', value: 20 }, { analyteCode: 'WBC', value: 7 }, { analyteCode: 'PLT', value: 250 }] }, ifMatch(1))).status).toBe(200);
  await as(scientist).put(`${itemUrl('MP_RDT')}/results`, { results: [{ analyteCode: 'MP', value: 'positive' }] }, ifMatch(1));
  expect((await as(scientist2).post(`${itemUrl('MP_RDT')}/verify`, {}, ifMatch(2))).status).toBe(200);
  await as(doctor).post(`/encounters/${visit.id}/prescriptions`, { items: [{ drugCode: 'PARA500', dose: 1000, doseUnit: 'mg', frequency: 'TDS', durationDays: 3 }] });
});

describe('the workspace dashboard', () => {
  it("gives a doctor today's figures and their own work queue", async () => {
    const res = await board(doctor);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.queue).toMatchObject({ waiting: 1, inProgress: 0, completed: 0, referred: 0 });
    expect(data.patients).toBe(1);
    expect(data.labPending).toBe(1);
    expect(data.prescriptionsPending).toBe(1);
    expect(data.work.unsignedNotes).toEqual([expect.objectContaining({ kind: 'CONSULTATION', reason: 'Dizziness', patient: expect.objectContaining({ name: 'Ngozi Obi' }) })]);
    expect(data.work.criticalResults).toEqual([expect.objectContaining({ testName: 'Full blood count', result: expect.stringContaining('6.2') })]);
    expect(data.work.resultsToAcknowledge).toEqual([expect.objectContaining({ testName: 'Malaria parasite (RDT)', abnormal: true, result: expect.stringContaining('POSITIVE') })]);
    expect(data.work.pendingLabTests).toEqual([expect.objectContaining({ collectedAt: expect.any(String), patient: expect.objectContaining({ name: 'Ngozi Obi' }) })]);
    expect(data.work.followUpsDue).toEqual([]);
    expect(data.month).toMatchObject({ outpatientVisits: 1, labTestsResulted: 1, admissions: 0, prescriptionsDispensed: 0 });
    // Not a doctor's business: stock is shown (they may view it), billing and the audit trail are not.
    expect(Array.isArray(data.lowStock)).toBe(true);
    expect(data.revenue).toBeNull();
    expect(data.activity).toBeNull();
  });

  it('keeps work queues personal and sections to the roles that may see them', async () => {
    const other = (await board(otherDoctor)).body.data;
    expect(other.work.unsignedNotes).toEqual([]);
    expect(other.work.resultsToAcknowledge).toEqual([]);

    const money = (await board(finance)).body.data;
    expect(money.revenue).toEqual({ collectedThisMonthMinor: 0, unpaidInvoices: 0 });
    expect(money.queue).toBeNull();
    expect(money.patients).toBeNull();
    expect(money.work).toEqual({});

    const pharmacy = (await board(pharmacist)).body.data;
    expect(pharmacy.prescriptionsPending).toBe(1);
    expect(pharmacy.lowStock.length).toBeGreaterThan(0); // nothing received yet: every drug is at or below reorder level
    expect(pharmacy.lowStock[0]).toMatchObject({ onHand: 0, reorderLevel: expect.any(Number) });

    const admin = (await board(A)).body.data;
    expect(admin.activity.length).toBeGreaterThan(0);
    expect(admin.activity.every((e) => !e.action.endsWith('.viewed'))).toBe(true);
    expect(admin.activity[0]).toHaveProperty('actorName');
  });

  it("needs the caller's day and month, and shows another organization nothing", async () => {
    expect((await board(doctor, '')).status).toBe(400);
    expect((await board(doctor, `?since=${encodeURIComponent('2020-01-01T00:00:00Z')}&monthStart=${encodeURIComponent(startOfMonth())}`)).status).toBe(400);
    const elsewhere = (await board(bDoctor)).body.data;
    expect(elsewhere).toMatchObject({ patients: 0, labPending: 0, prescriptionsPending: 0, queue: { waiting: 0 } });
    expect(elsewhere.work.criticalResults).toEqual([]);
  });
});
