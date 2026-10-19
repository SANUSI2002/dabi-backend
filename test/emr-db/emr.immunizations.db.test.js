// Immunization and surveillance against real Postgres with RLS on: minimum ages, one dose per
// antigen, defaulters, AEFI (serious ones open a surveillance case), surveillance notify/classify,
// corrections, permissions and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const weeksAgo = (n) => new Date(Date.now() - n * 7 * 86_400_000).toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let doctor; let nurse; let desk; let admin; let bNurse;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const child = async (ageWeeks) => (await as(A).post('/patients', newPatient({ sex: 'MALE', dateOfBirth: weeksAgo(ageWeeks) }))).body.data;
const give = (who, patientId, vaccineCode, extra = {}) => as(who).post('/immunizations', { patientId, vaccineCode, batchNumber: 'LOT-2201', site: 'Left outer thigh', ...extra }, key());

beforeAll(async () => {
  A = await createTenant('immA');
  B = await createTenant('immB');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  bNurse = await member(B, ['NURSE']);
});

describe('immunization', () => {
  it('gives each antigen once and never before its minimum age', async () => {
    const baby = await child(7);
    const dose = await give(nurse, baby.id, 'PENTA1');
    expect(dose.status, JSON.stringify(dose.body)).toBe(201);
    expect(dose.body.data).toMatchObject({ vaccineCode: 'PENTA1', vaccineName: 'Pentavalent Vaccine (Dose 1)', batchNumber: 'LOT-2201', givenByName: expect.any(String), aefi: null });
    const again = await give(nurse, baby.id, 'PENTA1');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DOSE_ALREADY_GIVEN');
    expect((await give(nurse, baby.id, 'PENTA2')).status).toBe(400); // due at 10 weeks
    expect((await give(nurse, baby.id, 'NOT_A_VACCINE')).status).toBe(400);
    // A wrong dose is marked in error, and can then be given again.
    expect((await as(nurse).post(`/immunizations/${dose.body.data.id}/entered-in-error`, { reason: 'Recorded on the twin' })).body.data.status).toBe('ENTERED_IN_ERROR');
    const redo = await give(nurse, baby.id, 'PENTA1');
    expect(redo.status).toBe(201);
    // The period list (reports) holds doses given within the dates asked for.
    const day = new Date().toISOString().slice(0, 10);
    expect((await as(nurse).get(`/immunizations?from=${day}&to=${day}&limit=2000`)).body.data.items.map((d) => d.id)).toContain(redo.body.data.id);
    expect((await as(nurse).get('/immunizations?from=2000-01-01&to=2000-01-31')).body.data.items).toEqual([]);
  });

  it('lists defaulters 4+ weeks past a dose they have not had', async () => {
    const baby = await child(15);
    for (const code of ['BCG', 'OPV0', 'HEPB0', 'OPV1', 'PENTA1', 'PCV1', 'ROTA1']) expect((await give(nurse, baby.id, code)).status).toBe(201);
    const row = (await as(nurse).get('/immunizations/defaulters')).body.data.items.find((d) => d.patientId === baby.id);
    expect(row.ageWeeks).toBe(15);
    // 10-week doses are 5 weeks late; 14-week doses are only 1 week late (not yet defaulted).
    expect(row.missed.map((m) => m.vaccineCode).sort()).toEqual(['OPV2', 'PCV2', 'PENTA2', 'ROTA2']);
    expect(row.missed.every((m) => m.weeksLate === 5)).toBe(true);
  });

  it('records an AEFI once; a serious one opens a suspected surveillance case', async () => {
    const baby = await child(40);
    const dose = (await give(nurse, baby.id, 'MV1')).body.data;
    const reported = await as(nurse).post(`/immunizations/${dose.id}/aefi`, { symptoms: 'High fever and convulsion 8 hours after dose', severity: 'SERIOUS', onsetHours: 8, actionTaken: 'Referred to General Hospital' });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    expect(reported.body.data.aefi).toMatchObject({ severity: 'SERIOUS', surveillanceCaseId: expect.any(String), reportedByName: expect.any(String) });
    expect((await as(nurse).post(`/immunizations/${dose.id}/aefi`, { symptoms: 'Again', severity: 'NON_SERIOUS', onsetHours: 1, actionTaken: 'None' })).status).toBe(409);
    expect((await as(nurse).post(`/immunizations/${dose.id}/entered-in-error`, { reason: 'Trying to hide it' })).status).toBe(409);

    const cases = (await as(doctor).get('/surveillance')).body.data.items;
    const opened = cases.find((c) => c.id === reported.body.data.aefi.surveillanceCaseId);
    expect(opened).toMatchObject({ diseaseCode: 'AEFI', source: 'AEFI', immediate: true, status: 'SUSPECTED', notes: expect.stringContaining('Measles Vaccine') });
    expect((await as(admin).get('/immunizations?aefi=true')).body.data.items.map((d) => d.id)).toContain(dose.id);
  });
});

describe('surveillance', () => {
  it('notifies a case (immediate from the IDSR list), and a doctor confirms or discards it once', async () => {
    const patient = (await as(A).post('/patients', newPatient())).body.data;
    const notified = await as(nurse).post('/surveillance', { patientId: patient.id, diseaseCode: 'LF', onsetDate: weeksAgo(0), notes: 'Fever, bleeding gums; travelled to Edo' }, key());
    expect(notified.status, JSON.stringify(notified.body)).toBe(201);
    expect(notified.body.data).toMatchObject({ diseaseName: 'Lassa Fever', immediate: true, status: 'SUSPECTED', reportedByName: expect.any(String) });
    const id = notified.body.data.id;
    expect((await as(nurse).post(`/surveillance/${id}/classify`, { status: 'CONFIRMED' }, ifMatch(1))).status).toBe(403);
    expect((await as(doctor).post(`/surveillance/${id}/classify`, { status: 'DISCARDED' }, ifMatch(1))).status).toBe(400); // needs a reason
    const confirmed = await as(doctor).post(`/surveillance/${id}/classify`, { status: 'CONFIRMED', note: 'PCR positive at reference lab' }, ifMatch(1));
    expect(confirmed.body.data).toMatchObject({ status: 'CONFIRMED', classifiedByName: expect.any(String) });
    expect((await as(doctor).post(`/surveillance/${id}/classify`, { status: 'DISCARDED', note: 'Changed mind' }, ifMatch(2))).status).toBe(409);
    const weekly = await as(nurse).post('/surveillance', { patientId: patient.id, diseaseCode: 'MAL' }, key());
    expect(weekly.body.data.immediate).toBe(false);
  });

  it('keeps the desk and other hospitals out, and the database refuses edits', async () => {
    const baby = await child(2);
    const dose = (await give(nurse, baby.id, 'BCG')).body.data;
    expect((await as(desk).get('/immunizations')).status).toBe(403);
    expect((await as(desk).get('/surveillance')).status).toBe(403);
    expect((await give(admin, baby.id, 'OPV0')).status).toBe(403);
    expect((await as(bNurse).get(`/immunizations?patientId=${baby.id}`)).body.data.items).toEqual([]);
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrImmunization.updateMany({ where: { id: dose.id }, data: { batchNumber: 'EDITED' } }))).rejects.toThrow();
  });
});
