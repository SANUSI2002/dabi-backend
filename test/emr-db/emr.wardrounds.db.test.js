// Ward rounds against real Postgres with RLS on: one draft per admission, problems carried forward,
// signing rules and a frozen signed record (amendments only), and medication decisions that act on the
// real prescriptions — a held medicine cannot be charted, a stopped one leaves the chart, a dose change
// raises a new prescription for pharmacy review.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };

let A; let B; let doctor; let nurse; let pharmacist; let bDoctor; let admission; let encounter; let amlodipine;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const rounds = async (who = doctor) => ok(await as(who).get(`/admissions/${admission.id}/ward-rounds`));
const mar = async () => ok(await as(nurse).get(`/admissions/${admission.id}/mar`));

beforeAll(async () => {
  A = await createTenant('wrA');
  B = await createTenant('wrB');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  pharmacist = await member(A, ['PHARMACIST']);
  bDoctor = await member(B, ['DOCTOR']);
  const ward = ok(await as(A).post('/wards', { code: 'MED', name: 'Medical ward', kind: 'GENERAL', beds: ['M1'] }), 201);
  const bed = ok(await as(A).get(`/wards/${ward.id}/beds`)).beds[0];
  const patient = ok(await as(A).post('/patients', newPatient()), 201);
  encounter = ok(await as(doctor).post('/encounters', { patientId: patient.id }), 201);
  admission = ok(await as(doctor).post(`/encounters/${encounter.id}/admission`, { bedId: bed.id, reason: 'Pneumonia' }), 201);
  const rx = ok(await as(doctor).post(`/encounters/${encounter.id}/prescriptions`, { items: [{ drugCode: 'AMLO5', dose: 5, doseUnit: 'mg', frequency: 'OD', durationDays: 5 }] }), 201);
  await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/approve`, {}, ifMatch(1));
  amlodipine = rx.items[0];
});

describe('ward rounds', () => {
  let round;
  it('starts one draft per admission, for clinicians only, and keeps other hospitals out', async () => {
    expect((await as(nurse).post(`/admissions/${admission.id}/ward-rounds`)).status).toBe(403);
    round = ok(await as(doctor).post(`/admissions/${admission.id}/ward-rounds`), 201);
    expect((await as(doctor).post(`/admissions/${admission.id}/ward-rounds`)).status).toBe(409); // one draft at a time
    expect((await as(bDoctor).get(`/admissions/${admission.id}/ward-rounds`)).status).toBe(404);
    const [r] = (await rounds(nurse)).rounds;
    expect(r).toMatchObject({ id: round.id, status: 'draft', participants: [expect.objectContaining({ role: 'Consultant' })], safetyChecklist: expect.objectContaining({ drugAllergiesReviewed: false }) });
  });

  it('refuses to sign without a progress note and a problem or plan', async () => {
    expect((await as(doctor).post(`/ward-rounds/${round.id}/sign`)).body.error.message).toMatch(/progress note/);
    ok(await as(doctor).patch(`/ward-rounds/${round.id}`, {
      clinicalProgress: 'Improving', progressNote: 'Afebrile overnight, tolerating orals.',
      problems: [{ id: 'prob-1', problem: 'Community-acquired pneumonia', status: 'Improving', update: 'Less crepitations', plan: 'Complete antibiotics' }],
      tasks: [{ id: 't-1', type: 'Repeat vitals', description: '4-hourly observations', priority: 'Routine', status: 'Pending' }],
    }, ifMatch(1)));
    expect((await as(doctor).patch(`/ward-rounds/${round.id}`, { progressNote: 'stale' }, ifMatch(1))).status).toBe(412);
    ok(await as(doctor).post(`/ward-rounds/${round.id}/examination`, { systems: [{ system: 'respiratory', status: 'Abnormal', notes: 'Right basal crepitations' }] }));
  });

  it('holds a medicine (charting refused), restarts it, and changes a dose with a new prescription for review', async () => {
    ok(await as(doctor).post(`/ward-rounds/${round.id}/medication-changes`, { prescriptionItemId: amlodipine.id, action: 'HELD', reason: 'Hypotensive this morning' }), 201);
    const held = (await mar()).medicines.find((m) => m.prescriptionItemId === amlodipine.id);
    expect(held.heldReason).toBe('Hypotensive this morning');
    const chart = await as(nurse).post(`/admissions/${admission.id}/mar`, { prescriptionItemId: amlodipine.id, status: 'GIVEN', dose: 5, doseUnit: 'mg' }, key());
    expect(chart.body.error.details.rule).toBe('HELD');
    ok(await as(doctor).post(`/ward-rounds/${round.id}/medication-changes`, { prescriptionItemId: amlodipine.id, action: 'RESTARTED', reason: 'BP recovered' }), 201);
    const change = ok(await as(doctor).post(`/ward-rounds/${round.id}/medication-changes`, { prescriptionItemId: amlodipine.id, action: 'DOSE_INCREASED', newDose: 10, reason: 'BP above target' }), 201);
    expect(change.replacementPrescriptionId).toEqual(expect.any(String));
    const rx = ok(await as(pharmacist).get(`/pharmacy/prescriptions/${change.replacementPrescriptionId}`));
    expect(rx).toMatchObject({ status: 'PENDING_REVIEW', items: [expect.objectContaining({ drugCode: 'AMLO5', dose: 10 })] });
    const old = await prisma.emrPrescriptionItem.findUnique({ where: { id: amlodipine.id } });
    expect(old).toMatchObject({ status: 'CANCELLED', closeOutcome: 'REPLACED' });
    expect((await as(doctor).post(`/ward-rounds/${round.id}/medication-changes`, { prescriptionItemId: amlodipine.id, action: 'STOPPED', reason: 'again' })).status).toBe(409);
    const { medicationChanges } = await rounds();
    expect(medicationChanges.map((c) => c.action)).toEqual(['DOSE_INCREASED', 'RESTARTED', 'HELD']);
    expect(medicationChanges[0]).toMatchObject({ previousDose: '5 mg', newDose: '10 mg', clinicianName: expect.any(String) });
  });

  it('starts a new medicine from the formulary, with the same safety checks as any prescription', async () => {
    const line = { drugCode: 'AMLO5', dose: 5, doseUnit: 'mg', frequency: 'NOCTE', durationDays: 3, indication: 'Night-time dosing trial' };
    const refused = await as(doctor).post(`/ward-rounds/${round.id}/medications`, line);
    expect(refused.body.error).toMatchObject({ code: 'SAFETY_CHECK_REQUIRED', details: [expect.objectContaining({ type: 'DUPLICATE_THERAPY' })] });
    const started = ok(await as(doctor).post(`/ward-rounds/${round.id}/medications`, { ...line, overrides: [{ drugCode: 'AMLO5', type: 'DUPLICATE_THERAPY', reason: 'Split dosing agreed on the round' }] }), 201);
    expect(started.prescriptionId).toEqual(expect.any(String));
    expect((await rounds()).medicationChanges[0]).toMatchObject({ action: 'STARTED', reason: 'Night-time dosing trial' });
  });

  it('signs with a summary of what was entered, freezes it, and carries problems to the next round', async () => {
    expect((await as(nurse).post(`/ward-rounds/${round.id}/sign`)).status).toBe(403);
    ok(await as(doctor).post(`/ward-rounds/${round.id}/sign`));
    const [signed] = (await rounds()).rounds;
    expect(signed).toMatchObject({ status: 'signed', signedBy: expect.any(String), examination: { systems: [expect.objectContaining({ system: 'respiratory' })] } });
    expect(signed.summary).toMatch(/Progress: Improving[\s\S]*Community-acquired pneumonia \(Improving\): Complete antibiotics[\s\S]*\[Repeat vitals\] 4-hourly observations/);
    const version = signed.version;
    expect((await as(doctor).patch(`/ward-rounds/${round.id}`, { progressNote: 'edited' }, ifMatch(version))).status).toBe(409);
    // even a direct write cannot change a signed round
    await expect(prisma.emrWardRound.update({ where: { id: round.id }, data: { progressNote: 'tampered' } })).rejects.toThrow();
    ok(await as(doctor).post(`/ward-rounds/${round.id}/amendments`, { note: 'Sputum culture grew S. pneumoniae.' }), 201);
    const next = ok(await as(doctor).post(`/admissions/${admission.id}/ward-rounds`), 201);
    const data = await rounds();
    expect(data.rounds.find((r) => r.id === round.id)).toMatchObject({ status: 'amended', amendments: [expect.objectContaining({ note: 'Sputum culture grew S. pneumoniae.' })] });
    expect(data.rounds.find((r) => r.id === next.id).problems).toEqual([expect.objectContaining({ problem: 'Community-acquired pneumonia' })]);
  });
});
