// The patient record (chart) and problem list against real Postgres with RLS on.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const today = () => new Date().toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let doctor; let nurse; let reception; let bDoctor;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

/** A finished visit with a signed, amended note, vitals, two diagnoses (one flagged chronic), a lab order and a prescription. */
async function visitedPatient() {
  const patient = (await as(A).post('/patients', newPatient())).body.data;
  const visit = (await as(doctor).post('/encounters', { patientId: patient.id, reason: 'Headache and fever' })).body.data;
  await as(doctor).post(`/encounters/${visit.id}/start`, {}, ifMatch(1));
  await as(nurse).post(`/encounters/${visit.id}/vitals`, { readings: [{ code: 'TEMPERATURE', value: 38.4 }, { code: 'HEART_RATE', value: 96 }] });
  const note = (await as(doctor).post(`/encounters/${visit.id}/notes`, { kind: 'CONSULTATION', subjective: 'Headache for 3 days', assessment: 'Malaria', plan: 'ACT' })).body.data;
  await as(doctor).post(`/encounters/${visit.id}/notes/${note.id}/sign`, {}, ifMatch(note.version));
  await as(doctor).post(`/encounters/${visit.id}/notes/${note.id}/amendments`, { reason: 'Added travel history', body: 'Travelled to Kano last week.' });
  const malaria = (await as(doctor).post(`/encounters/${visit.id}/diagnoses`, { codeSystem: 'ICD11', code: '1F40', description: 'Malaria, uncomplicated', rank: 'PRIMARY' })).body.data;
  const htn = (await as(doctor).post(`/encounters/${visit.id}/diagnoses`, { codeSystem: 'ICD11', code: 'BA00', description: 'Essential hypertension', onProblemList: true })).body.data;
  expect((await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['FBC'] })).status).toBe(201);
  expect((await as(doctor).post(`/encounters/${visit.id}/prescriptions`, { items: [{ drugCode: 'PARA500', dose: 1000, doseUnit: 'mg', frequency: 'TDS', durationDays: 3 }] })).status).toBe(201);
  return { patient, visit, malaria, htn };
}

beforeAll(async () => {
  A = await createTenant('recordA');
  B = await createTenant('recordB');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  reception = await member(A, ['RECEPTIONIST']);
  bDoctor = await member(B, ['DOCTOR']);
});

describe('the patient record', () => {
  it('brings the whole chart together with names, and leaves out what the role may not read', async () => {
    const { patient, visit } = await visitedPatient();
    const res = await as(doctor).get(`/patients/${patient.id}/record`);
    expect(res.status).toBe(200);
    const record = res.body.data;
    expect(record.patient).toMatchObject({ id: patient.id, medicalRecordNumber: patient.medicalRecordNumber, dateOfBirth: patient.dateOfBirth });

    const [encounter] = record.encounters;
    expect(encounter).toMatchObject({ id: visit.id, reason: 'Headache and fever', status: 'IN_PROGRESS', queueEntry: { station: expect.any(String), status: expect.any(String) } });
    expect(encounter.notes).toHaveLength(1);
    expect(encounter.notes[0]).toMatchObject({ kind: 'CONSULTATION', status: 'SIGNED', subjective: 'Headache for 3 days', authorName: expect.any(String), signedByName: expect.any(String) });
    expect(encounter.notes[0].amendments).toEqual([expect.objectContaining({ reason: 'Added travel history', body: 'Travelled to Kano last week.', authorName: expect.any(String) })]);
    expect(encounter.diagnoses.map((d) => d.code)).toEqual(['1F40', 'BA00']);

    expect(record.vitals.map((v) => [v.code, v.value])).toEqual(expect.arrayContaining([['TEMPERATURE', 38.4], ['HEART_RATE', 96]]));
    expect(record.vitals[0].recordedByName).toEqual(expect.any(String));
    expect(record.labs).toHaveLength(1);
    expect(record.labs[0].items[0]).toMatchObject({ testCode: 'FBC' });
    expect(record.prescriptions).toHaveLength(1);
    expect(record.prescriptions[0].items[0]).toMatchObject({ drugCode: 'PARA500' });
    expect(record.sections).toMatchObject({ labs: true, prescriptions: true });
    // Doctors do not hold billing.read, so invoices are left out (not shown as "none").
    expect(record.sections.invoices).toBe(false);
    expect(record.invoices).toBeNull();

    // The flagged chronic diagnosis shows on the problem list; the visit-only one does not.
    expect(record.problems).toEqual([expect.objectContaining({ problemId: null, code: 'BA00', clinicalStatus: 'ACTIVE', verificationStatus: null })]);

    const audit = await withTenant({ organizationId: A.organizationId, userId: doctor.userId }, (tx) => tx.emrAuditEvent.findFirst({ where: { action: 'patient_record.viewed', resourceId: patient.id } }));
    expect(audit).toBeTruthy();
  });

  it('is for clinicians, and another organization sees nothing', async () => {
    const { patient } = await visitedPatient();
    expect((await as(nurse).get(`/patients/${patient.id}/record`)).status).toBe(200);
    expect((await as(reception).get(`/patients/${patient.id}/record`)).status).toBe(403);
    expect((await as(bDoctor).get(`/patients/${patient.id}/record`)).body.error.code).toBe('PATIENT_NOT_FOUND');
    expect((await as(bDoctor).post(`/patients/${patient.id}/problems`, { code: 'BA00', description: 'Essential hypertension' })).status).toBe(404);
  });
});

describe('the problem list', () => {
  it('keeps a flagged diagnosis once it changes, one entry per code, and dates its resolution', async () => {
    const { patient, htn, malaria } = await visitedPatient();
    const stored = await as(doctor).post(`/patients/${patient.id}/problems`, { fromDiagnosisId: htn.id, verificationStatus: 'CONFIRMED' });
    expect(stored.status).toBe(201);
    expect(stored.body.data).toMatchObject({ code: 'BA00', codeSystem: 'ICD11', sourceDiagnosisId: htn.id, verificationStatus: 'CONFIRMED', clinicalStatus: 'ACTIVE', version: 1 });
    expect(stored.body.data.onsetDate).toBe(today());

    // Now stored, the diagnosis is no longer listed separately; the same code cannot be added twice.
    const problems = (await as(doctor).get(`/patients/${patient.id}/record`)).body.data.problems;
    expect(problems).toEqual([expect.objectContaining({ problemId: stored.body.data.id, code: 'BA00' })]);
    expect((await as(doctor).post(`/patients/${patient.id}/problems`, { fromDiagnosisId: htn.id })).body.error.code).toBe('PROBLEM_ALREADY_RECORDED');
    expect((await as(doctor).post(`/patients/${patient.id}/problems`, { code: 'BA00', description: 'Hypertension again' })).body.error.code).toBe('PROBLEM_ALREADY_RECORDED');

    // A coded entry added directly (validated as ICD-11).
    expect((await as(doctor).post(`/patients/${patient.id}/problems`, { code: 'not a code', description: 'Asthma' })).status).toBe(400);
    expect((await as(doctor).post(`/patients/${patient.id}/problems`, { fromDiagnosisId: malaria.id, code: '1F40' })).status).toBe(400);
    const asthma = await as(doctor).post(`/patients/${patient.id}/problems`, { code: 'CA23', description: 'Asthma', onsetDate: '2019-05-01', note: 'Uses inhaler' });
    expect(asthma.body.data).toMatchObject({ verificationStatus: 'PROVISIONAL', onsetDate: '2019-05-01', note: 'Uses inhaler', recordedByName: expect.any(String) });

    // Resolving records today's date; a stale version is refused; reactivating clears the date.
    const resolved = await as(doctor).patch(`/patients/${patient.id}/problems/${asthma.body.data.id}`, { clinicalStatus: 'RESOLVED' }, ifMatch(1));
    expect(resolved.body.data).toMatchObject({ clinicalStatus: 'RESOLVED', abatementDate: today(), version: 2, updatedByName: expect.any(String) });
    expect((await as(doctor).patch(`/patients/${patient.id}/problems/${asthma.body.data.id}`, { clinicalStatus: 'ACTIVE' }, ifMatch(1))).status).toBe(412);
    const back = await as(doctor).patch(`/patients/${patient.id}/problems/${asthma.body.data.id}`, { clinicalStatus: 'RECURRENCE' }, ifMatch(2));
    expect(back.body.data).toMatchObject({ clinicalStatus: 'RECURRENCE', abatementDate: null });
    expect((await as(doctor).patch(`/patients/${patient.id}/problems/${asthma.body.data.id}`, {}, ifMatch(3))).status).toBe(400);
  });

  it('is changed by doctors only, and the database refuses edits to what was recorded', async () => {
    const { patient } = await visitedPatient();
    expect((await as(nurse).post(`/patients/${patient.id}/problems`, { code: 'BA00', description: 'Essential hypertension' })).status).toBe(403);
    const row = (await as(doctor).post(`/patients/${patient.id}/problems`, { code: '5A11', description: 'Type 2 diabetes mellitus' })).body.data;
    const ctx = { organizationId: A.organizationId, userId: doctor.userId };
    await expect(withTenant(ctx, (tx) => tx.emrProblem.updateMany({ where: { id: row.id }, data: { code: 'BA00' } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.emrProblem.deleteMany({ where: { id: row.id } }))).rejects.toThrow();
  });
});

describe('allergy details', () => {
  it('keeps category, criticality and reactions, and an unconfirmed allergy can be confirmed once', async () => {
    const patient = (await as(A).post('/patients', newPatient())).body.data;
    const recorded = await as(nurse).post(`/patients/${patient.id}/allergies`, {
      substance: 'Peanut', substanceCode: 'PEANUT', severity: 'SEVERE', category: 'FOOD', criticality: 'HIGH', verificationStatus: 'UNCONFIRMED',
      manifestations: ['Urticaria (hives)', 'Angioedema'], reaction: 'Swelling within minutes', source: 'Reported by mother',
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body.data).toMatchObject({ category: 'FOOD', criticality: 'HIGH', verificationStatus: 'UNCONFIRMED', manifestations: ['Urticaria (hives)', 'Angioedema'] });
    expect((await as(nurse).post(`/patients/${patient.id}/allergies`, { substance: 'Egg', substanceCode: 'EGG', manifestations: ['Rash', 'Rash'] })).status).toBe(400);

    const confirmed = await as(doctor).post(`/patients/${patient.id}/allergies/${recorded.body.data.id}/confirm`);
    expect(confirmed.body.data).toMatchObject({ verificationStatus: 'CONFIRMED', verifiedByUserId: doctor.userId });
    const again = await as(doctor).post(`/patients/${patient.id}/allergies/${recorded.body.data.id}/confirm`);
    expect(again.body.data.verifiedAt).toBe(confirmed.body.data.verifiedAt);
    expect((await as(reception).post(`/patients/${patient.id}/allergies/${recorded.body.data.id}/confirm`)).status).toBe(403);

    const chart = (await as(doctor).get(`/patients/${patient.id}/record`)).body.data;
    expect(chart.allergies).toEqual([expect.objectContaining({ substance: 'Peanut', verifiedByName: expect.any(String), recordedByName: expect.any(String) })]);
    // Older allergies (no details) read as confirmed, and the details cannot be edited afterwards.
    const ctx = { organizationId: A.organizationId, userId: doctor.userId };
    await expect(withTenant(ctx, (tx) => tx.emrPatientAllergy.updateMany({ where: { id: recorded.body.data.id }, data: { criticality: 'LOW' } }))).rejects.toThrow();
  });
});
