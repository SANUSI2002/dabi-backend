// Encounters against real Postgres with RLS on. Use-case ids refer to docs/emr-backend.md §6.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const base = (tenant) => `/api/v1/emr/organizations/${tenant.organizationId}`;
const as = (who) => ({
  get: (path) => request(app).get(`${who.base}${path}`).set('Authorization', who.auth),
  post: (path, body = {}, headers = {}) => request(app).post(`${who.base}${path}`).set('Authorization', who.auth).set(headers).send(body),
  patch: (path, body, headers = {}) => request(app).patch(`${who.base}${path}`).set('Authorization', who.auth).set(headers).send(body),
});

let A; let B;
let admin; let doctor; let nurse; let reception; let lab; let otherDoctor;
let bAdmin;
const staff = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), base: base(tenant) });

async function patientIn(who) {
  const response = await who.post('/patients', newPatient());
  expect(response.status).toBe(201);
  return response.body.data;
}
async function checkIn(who, patient, body = {}) {
  return who.post('/encounters', { patientId: patient.id, reason: 'Headache for 3 days', ...body });
}
async function openVisit() {
  const patient = await patientIn(as(admin));
  const visit = (await checkIn(as(reception), patient)).body.data;
  const started = await as(doctor).post(`/encounters/${visit.id}/start`, {}, { 'If-Match': 'W/"1"' });
  expect(started.status).toBe(200);
  return { patient, visit: started.body.data };
}

beforeAll(async () => {
  A = await createTenant('encA');
  B = await createTenant('encB');
  admin = { ...A, base: base(A) };
  bAdmin = { ...B, base: base(B) };
  doctor = await staff(A, ['DOCTOR']);
  otherDoctor = await staff(A, ['DOCTOR']);
  nurse = await staff(A, ['NURSE']);
  reception = await staff(A, ['RECEPTIONIST']);
  lab = await staff(A, ['LAB_SCIENTIST']);
});

describe('check-in', () => {
  it('reception checks a patient in; a second open visit is refused; replays are safe', async () => {
    const patient = await patientIn(as(admin));
    const key = `checkin-${patient.id}`;
    const first = await as(reception).post('/encounters', { patientId: patient.id }, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('ARRIVED');
    expect(first.body.data.patient.medicalRecordNumber).toBe(patient.medicalRecordNumber);
    const replay = await as(reception).post('/encounters', { patientId: patient.id }, { 'Idempotency-Key': key });
    expect(replay.body.data.id).toBe(first.body.data.id);
    const again = await checkIn(as(reception), patient);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ENCOUNTER_ALREADY_OPEN');
  });

  it('two simultaneous check-ins for one patient → one 201, one 409', async () => {
    const patient = await patientIn(as(admin));
    const results = await Promise.all([checkIn(as(reception), patient), checkIn(as(nurse), patient)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('UC-17: a deactivated patient cannot be checked in', async () => {
    const patient = await patientIn(as(admin));
    await as(admin).post(`/patients/${patient.id}/deactivate`, { reason: 'Merged duplicate' }, { 'If-Match': 'W/"1"' });
    const response = await checkIn(as(reception), patient);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PATIENT_INACTIVE');
  });

  it('the attending clinician must be an active doctor of this organization', async () => {
    const patient = await patientIn(as(admin));
    expect((await checkIn(as(reception), patient, { attendingUserId: nurse.userId })).status).toBe(400);
    const ok = await checkIn(as(reception), patient, { attendingUserId: doctor.userId });
    expect(ok.status).toBe(201);
    expect(ok.body.data.attendingUserId).toBe(doctor.userId);
  });
});

describe('tenant isolation for encounters', () => {
  it('UC-1f: tenant A cannot open a visit for tenant B\'s patient — API says 404, the database refuses the row', async () => {
    const bPatient = await patientIn(as(bAdmin));
    const api = await checkIn(as(reception), bPatient);
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe('PATIENT_NOT_FOUND');
    await expect(withTenant({ organizationId: A.organizationId }, (tx) => tx.emrEncounter.create({
      data: { organizationId: A.organizationId, patientId: bPatient.id, createdByUserId: A.userId },
    }))).rejects.toThrow();
  });

  it('tenant B cannot see, change or annotate tenant A\'s visits', async () => {
    const { visit } = await openVisit();
    expect((await as(bAdmin).get(`/encounters/${visit.id}`)).status).toBe(404);
    const list = await as(bAdmin).get('/encounters');
    expect(list.body.data.items.map((e) => e.id)).not.toContain(visit.id);
    const bDoctor = await staff(B, ['DOCTOR']);
    expect((await as(bDoctor).post(`/encounters/${visit.id}/finish`, {}, { 'If-Match': 'W/"2"' })).status).toBe(404);
    expect((await as(bDoctor).get(`/encounters/${visit.id}/notes`)).status).toBe(404);
    expect((await as(bDoctor).post(`/encounters/${visit.id}/notes`, { kind: 'PROGRESS', body: 'x' })).status).toBe(404);
    expect((await as(bDoctor).post(`/encounters/${visit.id}/vitals`, { readings: [{ code: 'HEART_RATE', value: 70 }] })).status).toBe(404);
  });
});

describe('UC-8: role permissions', () => {
  it('reception sees the visit list but no clinical content; lab sees nothing; admin sees visits only', async () => {
    const { visit } = await openVisit();
    expect((await as(reception).get(`/encounters?status=ARRIVED,IN_PROGRESS`)).status).toBe(200);
    expect((await as(reception).get(`/encounters/${visit.id}/notes`)).status).toBe(403);
    expect((await as(reception).post(`/encounters/${visit.id}/vitals`, { readings: [{ code: 'HEART_RATE', value: 80 }] })).status).toBe(403);
    expect((await as(reception).post(`/encounters/${visit.id}/start`, {}, { 'If-Match': 'W/"2"' })).status).toBe(403);
    expect((await as(lab).get('/encounters')).status).toBe(403);
    expect((await as(admin).get(`/encounters/${visit.id}`)).status).toBe(200);
    expect((await as(admin).get(`/encounters/${visit.id}/vitals`)).status).toBe(403);
  });

  it('a nurse records vitals and signs nursing notes, but cannot write consultation notes or diagnose', async () => {
    const { visit } = await openVisit();
    expect((await as(nurse).post(`/encounters/${visit.id}/vitals`, { readings: [{ code: 'TEMPERATURE', value: 37.2 }] })).status).toBe(201);
    const muac = await as(nurse).post(`/encounters/${visit.id}/vitals`, { readings: [{ code: 'MUAC', value: 11.2 }] });
    expect(muac.body.data.items).toEqual([expect.objectContaining({ code: 'MUAC', unit: 'cm' })]);
    expect((await as(nurse).post(`/encounters/${visit.id}/vitals`, { readings: [{ code: 'MUAC', value: 90 }] })).status).toBe(400);
    const nursing = await as(nurse).post(`/encounters/${visit.id}/notes`, { kind: 'NURSING', body: 'Patient settled, obs stable.' });
    expect(nursing.status).toBe(201);
    expect((await as(nurse).post(`/encounters/${visit.id}/notes/${nursing.body.data.id}/sign`, {}, { 'If-Match': 'W/"1"' })).status).toBe(200);
    const consult = await as(nurse).post(`/encounters/${visit.id}/notes`, { kind: 'CONSULTATION', assessment: 'x' });
    expect(consult.status).toBe(403);
    expect((await as(nurse).post(`/encounters/${visit.id}/diagnoses`, { code: 'R51', description: 'Headache' })).status).toBe(403);
  });
});

describe('visit lifecycle', () => {
  it('start → finish with versions; illegal moves are refused; closed visits take no new vitals', async () => {
    const patient = await patientIn(as(admin));
    const visit = (await checkIn(as(reception), patient)).body.data;
    const url = `/encounters/${visit.id}`;
    expect((await as(doctor).post(`${url}/finish`, {}, { 'If-Match': 'W/"1"' })).status).toBe(409);
    expect((await as(doctor).post(`${url}/start`, {})).status).toBe(428);
    const started = await as(doctor).post(`${url}/start`, {}, { 'If-Match': 'W/"1"' });
    expect(started.body.data.status).toBe('IN_PROGRESS');
    expect(started.body.data.startedAt).toBeTruthy();
    expect((await as(doctor).post(`${url}/start`, {}, { 'If-Match': 'W/"1"' })).status).toBe(409);
    const finished = await as(doctor).post(`${url}/finish`, {}, { 'If-Match': 'W/"2"' });
    expect(finished.body.data.status).toBe('FINISHED');
    const late = await as(nurse).post(`${url}/vitals`, { readings: [{ code: 'HEART_RATE', value: 72 }] });
    expect(late.status).toBe(409);
    // Once finished, the patient can be checked in again.
    expect((await checkIn(as(reception), patient)).status).toBe(201);
  });

  it('cancelling needs a reason', async () => {
    const patient = await patientIn(as(admin));
    const visit = (await checkIn(as(reception), patient)).body.data;
    expect((await as(nurse).post(`/encounters/${visit.id}/cancel`, {}, { 'If-Match': 'W/"1"' })).status).toBe(400);
    const cancelled = await as(nurse).post(`/encounters/${visit.id}/cancel`, { reason: 'Patient left before triage' }, { 'If-Match': 'W/"1"' });
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(cancelled.body.data.cancellationReason).toBe('Patient left before triage');
  });
});

describe('UC-16: clinical notes', () => {
  it('a signed note is locked; an amendment keeps the original and records who, when and why', async () => {
    const { visit } = await openVisit();
    const url = `/encounters/${visit.id}/notes`;
    const draft = await as(doctor).post(url, { kind: 'CONSULTATION', subjective: 'Headache 3/7', assessment: 'Tension headache', plan: 'Analgesia' });
    expect(draft.status).toBe(201);
    const noteId = draft.body.data.id;

    // Only the author edits a draft.
    expect((await as(otherDoctor).patch(`${url}/${noteId}`, { plan: 'Other' }, { 'If-Match': 'W/"1"' })).status).toBe(403);
    const edited = await as(doctor).patch(`${url}/${noteId}`, { plan: 'Paracetamol 1g PRN' }, { 'If-Match': 'W/"1"' });
    expect(edited.status).toBe(200);
    expect(edited.headers.etag).toBe('W/"2"');

    const signed = await as(doctor).post(`${url}/${noteId}/sign`, {}, { 'If-Match': 'W/"2"' });
    expect(signed.status).toBe(200);
    expect(signed.body.data.status).toBe('SIGNED');
    expect(signed.body.data.signedByUserId).toBe(doctor.userId);

    const tamper = await as(doctor).patch(`${url}/${noteId}`, { plan: 'Changed after signing' }, { 'If-Match': 'W/"3"' });
    expect(tamper.status).toBe(409);
    expect(tamper.body.error.code).toBe('NOTE_SIGNED');
    // Even a direct database write cannot change or delete it.
    await expect(prisma.emrClinicalNote.update({ where: { id: noteId }, data: { plan: 'db tamper' } })).rejects.toThrow();
    await expect(prisma.emrClinicalNote.delete({ where: { id: noteId } })).rejects.toThrow();

    const amended = await as(otherDoctor).post(`${url}/${noteId}/amendments`, { reason: 'Dose clarified', body: 'Paracetamol 1g every 6 hours as needed, max 4g/day' });
    expect(amended.status).toBe(201);
    const list = await as(doctor).get(url);
    const note = list.body.data.items.find((n) => n.id === noteId);
    expect(note.plan).toBe('Paracetamol 1g PRN');
    expect(note.amendments).toHaveLength(1);
    expect(note.amendments[0]).toMatchObject({ authorUserId: otherDoctor.userId, reason: 'Dose clarified' });
    await expect(prisma.emrNoteAmendment.deleteMany({ where: { noteId } })).rejects.toThrow();

    const events = await prisma.emrOutboxEvent.findMany({ where: { aggregateId: noteId } });
    expect(events.map((e) => e.eventType).sort()).toEqual(['clinical_note.amended', 'clinical_note.signed']);
    expect(JSON.stringify(events)).not.toMatch(/Paracetamol|headache/i);
    const audit = await prisma.emrAuditEvent.findMany({ where: { resourceId: visit.id, action: 'clinical_note.viewed' } });
    expect(audit.length).toBeGreaterThan(0);
  });

  it('a draft cannot be amended and an empty note is refused', async () => {
    const { visit } = await openVisit();
    const draft = await as(doctor).post(`/encounters/${visit.id}/notes`, { kind: 'PROGRESS', body: 'Reviewed.' });
    expect((await as(doctor).post(`/encounters/${visit.id}/notes/${draft.body.data.id}/amendments`, { reason: 'Nope', body: 'x' })).status).toBe(409);
    expect((await as(doctor).post(`/encounters/${visit.id}/notes`, { kind: 'PROGRESS', body: '   ' })).status).toBe(400);
  });
});

describe('vitals and diagnoses', () => {
  it('validates readings, fixes units, and corrects by marking entered-in-error (values never change)', async () => {
    const { visit } = await openVisit();
    const url = `/encounters/${visit.id}/vitals`;
    expect((await as(nurse).post(url, { readings: [{ code: 'BP_SYSTOLIC', value: 120 }] })).status).toBe(400);
    expect((await as(nurse).post(url, { readings: [{ code: 'BP_SYSTOLIC', value: 80 }, { code: 'BP_DIASTOLIC', value: 120 }] })).status).toBe(400);
    expect((await as(nurse).post(url, { readings: [{ code: 'SPO2', value: 140 }] })).status).toBe(400);
    const recorded = await as(nurse).post(url, { readings: [{ code: 'BP_SYSTOLIC', value: 128 }, { code: 'BP_DIASTOLIC', value: 82 }, { code: 'TEMPERATURE', value: 37.8 }] });
    expect(recorded.status).toBe(201);
    const temp = recorded.body.data.items.find((o) => o.code === 'TEMPERATURE');
    expect(temp).toMatchObject({ value: 37.8, unit: 'Cel', status: 'ACTIVE' });

    const marked = await as(nurse).post(`${url}/${temp.id}/entered-in-error`, { reason: 'Wrong patient thermometer' });
    expect(marked.body.data.status).toBe('ENTERED_IN_ERROR');
    expect((await as(nurse).post(`${url}/${temp.id}/entered-in-error`, { reason: 'Again' })).status).toBe(409);
    // The request role may only touch the error columns, never the value.
    await expect(withTenant({ organizationId: A.organizationId }, (tx) => tx.emrObservation.updateMany({ where: { id: temp.id }, data: { value: 36.5 } }))).rejects.toThrow();
    const list = await as(doctor).get(url);
    expect(list.body.data.items.find((o) => o.id === temp.id).value).toBe(37.8);
  });

  it('records ICD-10 diagnoses with one active primary per visit', async () => {
    const { visit } = await openVisit();
    const url = `/encounters/${visit.id}/diagnoses`;
    expect((await as(doctor).post(url, { code: 'headache', description: 'x' })).status).toBe(400);
    const primary = await as(doctor).post(url, { code: 'g44.2', description: 'Tension-type headache', rank: 'PRIMARY' });
    expect(primary.status).toBe(201);
    expect(primary.body.data.code).toBe('G44.2');
    const second = await as(doctor).post(url, { code: 'R51', description: 'Headache', rank: 'PRIMARY' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PRIMARY_DIAGNOSIS_EXISTS');
    await as(doctor).post(`${url}/${primary.body.data.id}/entered-in-error`, { reason: 'Revised after review' });
    expect((await as(doctor).post(url, { code: 'R51', description: 'Headache', rank: 'PRIMARY' })).status).toBe(201);
  });
});

describe('consultation record', () => {
  it('accepts ICD-11 codes (checked against their own format) and flags problem-list diagnoses', async () => {
    const { visit } = await openVisit();
    const url = `/encounters/${visit.id}/diagnoses`;
    const malaria = await as(doctor).post(url, { codeSystem: 'ICD11', code: '1f40', description: 'Malaria, uncomplicated', rank: 'PRIMARY' });
    expect(malaria.status).toBe(201);
    expect(malaria.body.data).toMatchObject({ codeSystem: 'ICD11', code: '1F40', onProblemList: false });
    const hypertension = await as(doctor).post(url, { codeSystem: 'ICD11', code: 'BA00', description: 'Essential hypertension', onProblemList: true });
    expect(hypertension.body.data).toMatchObject({ codeSystem: 'ICD11', onProblemList: true });
    expect((await as(doctor).post(url, { codeSystem: 'ICD11', code: 'G44.2', description: 'ICD-10 code sent as ICD-11' })).status).toBe(400);
    expect((await as(doctor).post(url, { codeSystem: 'ICD11', code: '1I40', description: 'I is never used in ICD-11' })).status).toBe(400);
    expect((await as(doctor).post(url, { code: '1F40', description: 'ICD-11 code sent as ICD-10' })).status).toBe(400);
    const listed = (await as(doctor).get(url)).body.data.items;
    expect(listed.map((d) => [d.codeSystem, d.code])).toEqual([['ICD11', '1F40'], ['ICD11', 'BA00']]);
  });

  it('keeps the structured examination, follow-up and patient instructions with the note, locked once signed', async () => {
    const { visit } = await openVisit();
    const examination = [
      { system: 'general', status: 'Normal' },
      { system: 'respiratory', status: 'Abnormal', findings: { Auscultation: 'Coarse crepitations right base' }, laterality: 'Right' },
    ];
    const created = await as(doctor).post(`/encounters/${visit.id}/notes`, {
      kind: 'CONSULTATION', subjective: 'Cough for 5 days', assessment: 'Community-acquired pneumonia',
      examination, followUp: 'Review in 3 days', patientInstructions: 'Complete the full antibiotic course',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ examination, followUp: 'Review in 3 days', patientInstructions: 'Complete the full antibiotic course' });
    const duplicated = [{ system: 'general', status: 'Normal' }, { system: 'general', status: 'Abnormal' }];
    expect((await as(doctor).patch(`/encounters/${visit.id}/notes/${created.body.data.id}`, { examination: duplicated }, { 'If-Match': 'W/"1"' })).status).toBe(400);
    expect((await as(doctor).patch(`/encounters/${visit.id}/notes/${created.body.data.id}`, { examination: [{ system: 'liver', status: 'Normal' }] }, { 'If-Match': 'W/"1"' })).status).toBe(400);
    const edited = await as(doctor).patch(`/encounters/${visit.id}/notes/${created.body.data.id}`, { followUp: 'Review in 2 days' }, { 'If-Match': 'W/"1"' });
    expect(edited.body.data.followUp).toBe('Review in 2 days');
    await as(doctor).post(`/encounters/${visit.id}/notes/${created.body.data.id}/sign`, {}, { 'If-Match': 'W/"2"' });
    expect((await as(doctor).patch(`/encounters/${visit.id}/notes/${created.body.data.id}`, { followUp: 'changed' }, { 'If-Match': 'W/"3"' })).status).toBe(409);
    await expect(withTenant({ organizationId: A.organizationId, userId: doctor.userId }, (tx) => tx.emrClinicalNote.updateMany({
      where: { organizationId: A.organizationId, id: created.body.data.id }, data: { patientInstructions: 'rewritten' },
    }))).rejects.toThrow();
  });

  it('records the visit type and NHMIS indicators on the visit while it is open', async () => {
    const { visit } = await openVisit();
    const updated = await as(doctor).patch(`/encounters/${visit.id}`, { visitType: 'Follow-up', nhmisIndicators: ['Presented with fever', 'Tested by RDT'] }, { 'If-Match': `W/"${visit.version}"` });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ visitType: 'Follow-up', nhmisIndicators: ['Presented with fever', 'Tested by RDT'] });
    expect((await as(doctor).patch(`/encounters/${visit.id}`, { nhmisIndicators: ['Same', 'Same'] }, { 'If-Match': `W/"${updated.body.data.version}"` })).status).toBe(400);
  });
});
