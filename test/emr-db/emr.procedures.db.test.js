// Procedures against real Postgres with RLS on: the lifecycle, the safety checklist, signing,
// billing and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const today = () => new Date().toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let doctor; let doctor2; let nurse; let desk; let finance; let admin; let bDoctor;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const iAndD = (patientId) => ({ patientId, name: 'Incision and drainage', indication: 'Fluctuant left thigh abscess, 4 cm', bodySite: 'Left thigh', laterality: 'LEFT', priority: 'URGENT' });

async function visit() {
  const patient = (await as(A).post('/patients', newPatient())).body.data;
  const encounter = (await as(doctor).post('/encounters', { patientId: patient.id })).body.data;
  return { patient, encounter };
}
/** Requests, schedules (doctor performing, nurse assisting) and consents a procedure; returns it at version 3. */
async function consented(patientId) {
  const p = (await as(doctor).post('/procedures', iAndD(patientId), key())).body.data;
  await as(doctor).post(`/procedures/${p.id}/schedule`, { scheduledFor: today(), performerUserId: doctor.userId, assistantUserIds: [nurse.userId] }, ifMatch(1));
  return (await as(nurse).post(`/procedures/${p.id}/consent`, { obtainedByUserId: doctor.userId }, ifMatch(2))).body.data;
}
const tickAll = async (p, who = nurse) => {
  for (const item of p.checklist) {
    await as(who).put(`/procedures/${p.id}/checklist/${item.id}`, item.position === 2 ? { completed: false, exceptionReason: 'No marking needed for a visible abscess' } : { completed: true });
  }
};

beforeAll(async () => {
  A = await createTenant('procA');
  B = await createTenant('procB');
  doctor = await member(A, ['DOCTOR']);
  doctor2 = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  finance = await member(A, ['FINANCE_OFFICER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  bDoctor = await member(B, ['DOCTOR']);
});

describe('the procedure lifecycle', () => {
  it('runs from request to signed note, with the checklist enforced before performing', async () => {
    const { patient, encounter } = await visit();
    const requested = await as(doctor).post('/procedures', iAndD(patient.id), key());
    expect(requested.status).toBe(201);
    const p = requested.body.data;
    expect(p).toMatchObject({ status: 'REQUESTED', code: 'INCISION_AND_DRAINAGE', encounterId: encounter.id, laterality: 'LEFT', requestedByName: expect.any(String) });
    expect(p.checklist).toHaveLength(10);
    expect(p.checklist.map((i) => i.phase)).toEqual(['SIGN_IN', 'SIGN_IN', 'SIGN_IN', 'SIGN_IN', 'TIME_OUT', 'TIME_OUT', 'TIME_OUT', 'SIGN_OUT', 'SIGN_OUT', 'SIGN_OUT']);
    expect((await as(desk).post('/procedures', iAndD(patient.id), key())).status).toBe(403);

    // Scheduling names a performer and assistants from the hospital's clinicians.
    expect((await as(doctor).post(`/procedures/${p.id}/schedule`, { scheduledFor: today(), performerUserId: desk.userId }, ifMatch(1))).status).toBe(400);
    const scheduled = await as(doctor).post(`/procedures/${p.id}/schedule`, { scheduledFor: today(), performerUserId: doctor.userId, assistantUserIds: [nurse.userId] }, ifMatch(1));
    expect(scheduled.body.data).toMatchObject({ status: 'SCHEDULED', scheduledFor: today(), performerName: expect.any(String), assistants: [{ userId: nurse.userId, name: expect.any(String) }] });

    // The checklist opens after consent.
    expect((await as(nurse).put(`/procedures/${p.id}/checklist/${p.checklist[0].id}`, { completed: true })).body.error.code).toBe('INVALID_STATE');
    const withConsent = await as(nurse).post(`/procedures/${p.id}/consent`, { obtainedByUserId: doctor.userId }, ifMatch(2));
    expect(withConsent.body.data).toMatchObject({ status: 'CONSENTED', consentObtainedByName: expect.any(String) });
    await as(nurse).post(`/procedures/${p.id}/pre-procedure`, {}, ifMatch(3));

    const operative = { anaesthesia: 'Local (lidocaine 1%)', outcome: 'Adequate drainage, about 15 mL pus', findings: 'No foreign body;\nwound packed', specimenSentToLab: true };
    const early = await as(doctor).post(`/procedures/${p.id}/perform`, operative, ifMatch(4));
    expect(early.body.error.code).toBe('VALIDATION_FAILED');
    expect(early.body.error.message).toMatch(/Complete the safety checklist first/);
    await tickAll(withConsent.body.data);
    const performed = await as(doctor).post(`/procedures/${p.id}/perform`, operative, ifMatch(4));
    expect(performed.body.data).toMatchObject({ status: 'PERFORMED', complications: 'None', findings: 'No foreign body;\nwound packed', specimenSentToLab: true, performedByName: expect.any(String) });
    expect(performed.body.data.checklist.find((i) => i.position === 2)).toMatchObject({ completed: false, exceptionReason: 'No marking needed for a visible abscess', updatedByName: expect.any(String) });
    expect((await as(nurse).post(`/procedures/${p.id}/cancel`, { reason: 'Too late' }, ifMatch(5))).body.error.code).toBe('INVALID_STATE');

    // Only the performer signs; the note is then corrected by amendments only.
    expect((await as(nurse).post(`/procedures/${p.id}/amendments`, { note: 'Too early' })).body.error.code).toBe('INVALID_STATE');
    expect((await as(doctor2).post(`/procedures/${p.id}/sign`, {}, ifMatch(5))).status).toBe(403);
    const signed = await as(doctor).post(`/procedures/${p.id}/sign`, {}, ifMatch(5));
    expect(signed.body.data).toMatchObject({ noteSignedByName: expect.any(String), noteSignedAt: expect.any(String) });
    expect((await as(doctor).post(`/procedures/${p.id}/sign`, {}, ifMatch(6))).body.error.code).toBe('INVALID_STATE');
    const amended = await as(doctor).post(`/procedures/${p.id}/amendments`, { note: 'Volume of pus was about 20 mL.' });
    expect(amended.status).toBe(201);
    expect(amended.body.data.amendments).toEqual([expect.objectContaining({ note: 'Volume of pus was about 20 mL.', authorName: expect.any(String) })]);

    const recovered = await as(nurse).post(`/procedures/${p.id}/recovery`, { recoveryNotes: 'Stable, no bleeding' }, ifMatch(6));
    expect(recovered.body.data).toMatchObject({ status: 'RECOVERY', recoveryNotes: 'Stable, no bleeding' });
    const followUp = await as(doctor).post(`/procedures/${p.id}/follow-up`, { followUpPlan: 'Dressing change in 48 h; review in 5 days' }, ifMatch(7));
    expect(followUp.body.data.status).toBe('FOLLOW_UP');

    const listed = (await as(admin).get(`/procedures?patientId=${patient.id}&status=FOLLOW_UP`)).body.data.items;
    expect(listed.map((x) => x.id)).toEqual([p.id]);
    expect((await as(admin).post(`/procedures/${p.id}/cancel`, { reason: 'Admin' }, ifMatch(8))).status).toBe(403);
  });

  it('cancels with a reason before performing, and refuses steps out of order', async () => {
    const { patient } = await visit();
    const p = (await as(nurse).post('/procedures', { patientId: patient.id, name: 'IUCD insertion', indication: 'Postpartum family planning' }, key())).body.data;
    expect(p.code).toBe('IUCD_INSERTION');
    expect((await as(nurse).post(`/procedures/${p.id}/consent`, { obtainedByUserId: nurse.userId }, ifMatch(1))).body.error.code).toBe('INVALID_STATE');
    expect((await as(nurse).post(`/procedures/${p.id}/pre-procedure`, {}, ifMatch(1))).body.error.code).toBe('INVALID_STATE');
    expect((await as(nurse).post(`/procedures/${p.id}/cancel`, {}, ifMatch(1))).status).toBe(400);
    const cancelled = await as(nurse).post(`/procedures/${p.id}/cancel`, { reason: 'Patient chose implant instead' }, ifMatch(1));
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Patient chose implant instead', cancelledByName: expect.any(String) });
  });
});

describe('around the hospital', () => {
  it('bills a performed procedure by its code and shows it on the patient record', async () => {
    const { patient, encounter } = await visit();
    expect((await as(finance).post('/billing/prices', { category: 'PROCEDURE', reference: 'INCISION_AND_DRAINAGE', name: 'Incision and drainage', unitPriceMinor: 1_500_000 })).status).toBe(201);
    const p = await consented(patient.id);
    await as(nurse).post(`/procedures/${p.id}/pre-procedure`, {}, ifMatch(3));
    await as(finance).post(`/billing/encounters/${encounter.id}/capture`);
    let charges = (await as(finance).get(`/billing/encounters/${encounter.id}/charges`)).body.data.items;
    expect(charges.filter((c) => c.category === 'PROCEDURE')).toEqual([]); // not billed before it is performed
    await tickAll(p);
    expect((await as(doctor).post(`/procedures/${p.id}/perform`, { outcome: 'Drained' }, ifMatch(4))).status).toBe(200);
    await as(finance).post(`/billing/encounters/${encounter.id}/capture`);
    await as(finance).post(`/billing/encounters/${encounter.id}/capture`);
    charges = (await as(finance).get(`/billing/encounters/${encounter.id}/charges`)).body.data.items;
    expect(charges.filter((c) => c.category === 'PROCEDURE')).toEqual([expect.objectContaining({ description: 'Incision and drainage', amountMinor: 1_500_000, sourceType: 'PROCEDURE' })]);

    const record = (await as(doctor).get(`/patients/${patient.id}/record`)).body.data;
    expect(record.sections.procedures).toBe(true);
    expect(record.procedures).toEqual([expect.objectContaining({ id: p.id, status: 'PERFORMED', checklist: expect.any(Array) })]);
  });

  it('keeps what was recorded unchangeable and other organizations out', async () => {
    const { patient } = await visit();
    const p = await consented(patient.id);
    const ctx = { organizationId: A.organizationId, userId: doctor.userId };
    await expect(withTenant(ctx, (tx) => tx.emrProcedure.updateMany({ where: { id: p.id }, data: { indication: 'Edited' } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.emrProcedureChecklistItem.updateMany({ where: { procedureId: p.id }, data: { label: 'Edited' } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.emrProcedure.deleteMany({ where: { id: p.id } }))).rejects.toThrow();

    expect((await as(bDoctor).get('/procedures')).body.data.items).toEqual([]);
    expect((await as(bDoctor).post(`/procedures/${p.id}/cancel`, { reason: 'Not ours' }, ifMatch(3))).status).toBe(404);
    expect((await as(bDoctor).post('/procedures', iAndD(patient.id), key())).body.error.code).toBe('PATIENT_NOT_FOUND');
  });
});
