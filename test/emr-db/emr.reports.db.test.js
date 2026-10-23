// Reports against real Postgres with RLS on: the report source (period visits with diagnoses and
// prescriptions, lab orders, only the people they name, register totals), period counts and MSF
// figures, and the Monthly Summary Form draft → compiled lock. Nothing is sent anywhere.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const today = () => new Date().toISOString().slice(0, 10);
const month = () => today().slice(0, 7);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let doctor; let nurse; let admin; let desk; let bAdmin; let seen; let unseen;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const period = () => `from=${today()}&to=${today()}`;

beforeAll(async () => {
  A = await createTenant('repA');
  B = await createTenant('repB');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  desk = await member(A, ['RECEPTIONIST']);
  bAdmin = await member(B, ['HOSPITAL_ADMIN']);
  seen = (await as(A).post('/patients', newPatient({ consentToContact: true }))).body.data;
  unseen = (await as(A).post('/patients', newPatient())).body.data;
  const visit = (await as(doctor).post('/encounters', { patientId: seen.id, reason: 'Fever for 2 days' })).body.data;
  await as(doctor).post(`/encounters/${visit.id}/start`, {}, ifMatch(1));
  await as(doctor).post(`/encounters/${visit.id}/diagnoses`, { codeSystem: 'ICD11', code: '1F40', description: 'Malaria, uncomplicated', rank: 'PRIMARY' });
  await as(doctor).post(`/encounters/${visit.id}/prescriptions`, { items: [{ drugCode: 'AL20_120', dose: 4, doseUnit: 'tablet', frequency: 'BD', durationDays: 3 }] });
  await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['MP_RDT'] });
});

describe('reports', () => {
  it('gives the report builder the period record, naming only the people in it', async () => {
    const source = (await as(admin).get(`/reports/source?${period()}`)).body.data;
    const visit = source.encounters.find((e) => e.patientId === seen.id);
    expect(visit).toMatchObject({ complaint: 'Fever for 2 days', diagnoses: [{ code: '1F40', name: 'Malaria, uncomplicated' }], prescriptions: [{ drug: expect.stringMatching(/Artemether/) }] });
    expect(source.labOrders.some((o) => o.patientId === seen.id && o.items.some((i) => i.testCode === 'MP_RDT'))).toBe(true);
    expect(source.patients.map((p) => p.id)).toContain(seen.id);
    expect(source.patients.map((p) => p.id)).not.toContain(unseen.id);
    expect(source.registry.total).toBeGreaterThanOrEqual(2);
    expect(source.registry.consentYes).toBeGreaterThanOrEqual(1);
    expect((await as(admin).get('/reports/source?from=2026-02-01&to=2026-01-01')).status).toBe(400);
  });

  it('counts datasets and MSF figures for the period', async () => {
    const counts = (await as(nurse).get(`/reports/counts?${period()}`)).body.data;
    expect(counts.datasets.opd).toBeGreaterThanOrEqual(1);
    expect(counts.msf).toMatchObject({ 'Total visits': counts.datasets.opd, 'Confirmed malaria': expect.any(Number) });
    expect(counts.msf['Confirmed malaria']).toBeGreaterThanOrEqual(1);
    expect(counts.msf['New attendances'] + counts.msf['Re-attendances']).toBe(counts.msf['Total visits']);
  });

  it('saves the MSF as a draft, then locks it as compiled', async () => {
    const first = (await as(admin).get(`/reports/msf/${month()}`)).body.data;
    expect(first).toMatchObject({ saved: null, derived: expect.objectContaining({ 'Total visits': expect.any(Number) }) });
    const draft = await as(admin).put(`/reports/msf/${month()}`, { values: { 'Total visits': 12, 'Maternal deaths': 0 } });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    expect(draft.body.data).toMatchObject({ status: 'DRAFT', version: 1, values: { 'Total visits': 12 } });
    expect((await as(admin).put(`/reports/msf/${month()}`, { values: { 'Total visits': 13 } })).status).toBe(428);
    expect((await as(admin).put(`/reports/msf/${month()}`, { values: { 'Total visits': 13 } }, ifMatch(1))).body.data.version).toBe(2);
    expect((await as(nurse).post(`/reports/msf/${month()}/compile`, {}, ifMatch(2))).status).toBe(403);
    const locked = await as(admin).post(`/reports/msf/${month()}/compile`, {}, ifMatch(2));
    expect(locked.body.data).toMatchObject({ status: 'COMPILED', compiledByName: expect.any(String) });
    expect((await as(admin).put(`/reports/msf/${month()}`, { values: { 'Total visits': 1 } }, ifMatch(3))).status).toBe(409);
    expect((await as(admin).put('/reports/msf/2026-13', { values: {} })).status).toBe(400);
  });

  it('keeps the desk out and hospitals apart', async () => {
    expect((await as(desk).get(`/reports/counts?${period()}`)).status).toBe(403);
    expect((await as(bAdmin).get(`/reports/source?${period()}`)).body.data.patients.map((p) => p.id)).not.toContain(seen.id);
    expect((await as(bAdmin).get(`/reports/msf/${month()}`)).body.data.saved).toBeNull();
    const ctx = { organizationId: A.organizationId, userId: admin.userId };
    await expect(withTenant(ctx, (tx) => tx.emrMsfReturn.deleteMany({}))).rejects.toThrow();
  });
});
