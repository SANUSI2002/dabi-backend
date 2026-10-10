// Radiology against real Postgres with RLS on: the study workflow, roles, billing and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const year = new Date().getUTCFullYear();
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

let A; let B; let doctor; let nurse; let radiographer; let radiologist; let finance; let bDoctor;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const chestXray = (patientId, extra = {}) => ({ patientId, modality: 'XRAY', bodySite: 'Chest', indication: 'Chronic cough, rule out consolidation', ...extra });
const study = (path, who = radiographer) => ({
  schedule: (version, scheduledFor = today()) => as(who).post(`/imaging/studies/${path}/schedule`, { scheduledFor }, ifMatch(version)),
  perform: (version, series = [{ description: 'PA chest', imageCount: 1 }]) => as(who).post(`/imaging/studies/${path}/perform`, { series }, ifMatch(version)),
});

async function visit() {
  const patient = (await as(A).post('/patients', newPatient())).body.data;
  const encounter = (await as(doctor).post('/encounters', { patientId: patient.id })).body.data;
  return { patient, encounter };
}

beforeAll(async () => {
  A = await createTenant('radA');
  B = await createTenant('radB');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  radiographer = await member(A, ['RADIOGRAPHER']);
  radiologist = await member(A, ['RADIOLOGIST']);
  finance = await member(A, ['FINANCE_OFFICER']);
  bDoctor = await member(B, ['DOCTOR']);
});

describe('the imaging workflow', () => {
  it('requests, schedules, performs, reports, verifies and amends — each step by its role', async () => {
    const { patient, encounter } = await visit();
    const requested = await as(doctor).post('/imaging/studies', chestXray(patient.id, { laterality: 'BILATERAL', preparation: 'Remove jewellery' }), key());
    expect(requested.status).toBe(201);
    const s = requested.body.data;
    expect(s).toMatchObject({ status: 'REQUESTED', encounterId: encounter.id, requestedByName: expect.any(String), series: [], report: null });
    expect(s.accessionNumber).toMatch(new RegExp(`^RAD-${year}-\\d{6}$`));
    expect(s.patient).toMatchObject({ id: patient.id, medicalRecordNumber: patient.medicalRecordNumber });

    expect((await study(s.id, doctor).schedule(1)).status).toBe(403);
    const scheduled = await study(s.id).schedule(1);
    expect(scheduled.body.data).toMatchObject({ status: 'SCHEDULED', scheduledFor: today(), scheduledByName: expect.any(String) });

    expect((await study(s.id).perform(2, [])).status).toBe(400);
    const performed = await study(s.id).perform(2, [{ description: 'PA chest', imageCount: 1 }, { description: 'Lateral chest', bodyPart: 'Chest (lateral)' }]);
    expect(performed.body.data).toMatchObject({ status: 'PERFORMED', performedByName: expect.any(String) });
    expect(performed.body.data.series.map((x) => [x.seriesNumber, x.description, x.bodyPart])).toEqual([[1, 'PA chest', 'Chest'], [2, 'Lateral chest', 'Chest (lateral)']]);

    expect((await as(radiographer).post(`/imaging/studies/${s.id}/report`, { findings: 'x', impression: 'y' }, ifMatch(3))).status).toBe(403);
    const reported = await as(radiologist).post(`/imaging/studies/${s.id}/report`, {
      findings: 'Lung fields clear.\nNo effusion or pneumothorax.', impression: 'No acute cardiopulmonary abnormality.',
    }, ifMatch(3));
    expect(reported.body.data).toMatchObject({ status: 'REPORTED', report: { findings: 'Lung fields clear.\nNo effusion or pneumothorax.', authorName: expect.any(String), verifiedAt: null } });

    const verified = await as(radiologist).post(`/imaging/studies/${s.id}/verify`, {}, ifMatch(4));
    expect(verified.body.data).toMatchObject({ status: 'VERIFIED', report: { verifiedByName: expect.any(String) } });
    expect((await as(radiologist).post(`/imaging/studies/${s.id}/report`, { findings: 'Changed', impression: 'Changed' }, ifMatch(5))).body.error.code).toBe('INVALID_STATE');

    const amended = await as(radiologist).post(`/imaging/studies/${s.id}/addenda`, { note: 'Compared with outside film: unchanged.' }, ifMatch(5));
    expect(amended.body.data).toMatchObject({ status: 'AMENDED', addenda: [expect.objectContaining({ note: 'Compared with outside film: unchanged.', authorName: expect.any(String) })] });
    expect((await as(radiologist).post(`/imaging/studies/${s.id}/addenda`, { note: 'Second note' }, ifMatch(6))).body.data.addenda).toHaveLength(2);

    // Clinicians read the result; listing by status and patient works.
    const list = (await as(nurse).get(`/imaging/studies?patientId=${patient.id}&status=AMENDED`)).body.data.items;
    expect(list.map((x) => x.id)).toEqual([s.id]);
  });

  it('records outside studies as performed for reporting only, and cancels only before performing', async () => {
    const { patient } = await visit();
    const outside = (await as(nurse).post('/imaging/studies', { patientId: patient.id, modality: 'ULTRASOUND', bodySite: 'Obstetric', indication: 'Dating scan done at another clinic', externalStudy: true }, key())).body.data;
    expect(outside).toMatchObject({ status: 'PERFORMED', externalStudy: true });
    expect((await study(outside.id).schedule(1)).body.error.code).toBe('INVALID_STATE');
    expect((await as(radiologist).post(`/imaging/studies/${outside.id}/report`, { findings: 'Single live intrauterine pregnancy.', impression: 'Dates consistent with 20 weeks.' }, ifMatch(1))).status).toBe(200);

    const mri = (await as(doctor).post('/imaging/studies', chestXray(patient.id, { modality: 'MRI', bodySite: 'Lumbar spine' }), key())).body.data;
    expect((await as(doctor).post(`/imaging/studies/${mri.id}/cancel`, {}, ifMatch(1))).status).toBe(400);
    const cancelled = await as(doctor).post(`/imaging/studies/${mri.id}/cancel`, { reason: 'Patient claustrophobic; CT instead' }, ifMatch(1));
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Patient claustrophobic; CT instead', cancelledByName: expect.any(String) });
    expect((await study(mri.id).perform(2)).body.error.code).toBe('INVALID_STATE');
    expect((await as(radiographer).post(`/imaging/studies/${outside.id}/cancel`, { reason: 'Too late' }, ifMatch(2))).body.error.code).toBe('INVALID_STATE');
  });

  it('compares with an earlier verified study of the same patient only', async () => {
    const { patient } = await visit();
    const first = (await as(doctor).post('/imaging/studies', chestXray(patient.id), key())).body.data;
    await study(first.id).perform(1);
    await as(radiologist).post(`/imaging/studies/${first.id}/report`, { findings: 'Clear.', impression: 'Normal.' }, ifMatch(2));
    await as(radiologist).post(`/imaging/studies/${first.id}/verify`, {}, ifMatch(3));
    const second = (await as(doctor).post('/imaging/studies', chestXray(patient.id), key())).body.data;
    const set = await as(radiologist).put(`/imaging/studies/${second.id}/comparison`, { compareToStudyId: first.id }, ifMatch(1));
    expect(set.body.data.compareToStudyId).toBe(first.id);
    expect((await as(radiologist).put(`/imaging/studies/${second.id}/comparison`, { compareToStudyId: second.id }, ifMatch(2))).status).toBe(400);
    const other = (await visit()).patient;
    const theirs = (await as(doctor).post('/imaging/studies', chestXray(other.id), key())).body.data;
    expect((await as(radiologist).put(`/imaging/studies/${theirs.id}/comparison`, { compareToStudyId: first.id }, ifMatch(1))).status).toBe(400);
    expect((await as(radiologist).put(`/imaging/studies/${second.id}/comparison`, { compareToStudyId: null }, ifMatch(2))).body.data.compareToStudyId).toBeNull();
  });
});

describe('around the hospital', () => {
  it('bills a performed study by modality and shows imaging on the patient record', async () => {
    const { patient, encounter } = await visit();
    expect((await as(finance).post('/billing/prices', { category: 'IMAGING', reference: 'XRAY', name: 'X-ray', unitPriceMinor: 750_000 })).status).toBe(201);
    const s = (await as(doctor).post('/imaging/studies', chestXray(patient.id), key())).body.data;
    expect((await as(finance).post(`/billing/encounters/${encounter.id}/capture`)).status).toBe(200);
    let charges = (await as(finance).get(`/billing/encounters/${encounter.id}/charges`)).body.data.items;
    expect(charges.filter((c) => c.category === 'IMAGING')).toEqual([]); // not billed until performed
    await study(s.id).perform(1);
    await as(finance).post(`/billing/encounters/${encounter.id}/capture`);
    await as(finance).post(`/billing/encounters/${encounter.id}/capture`); // capture is idempotent
    charges = (await as(finance).get(`/billing/encounters/${encounter.id}/charges`)).body.data.items;
    expect(charges.filter((c) => c.category === 'IMAGING')).toEqual([expect.objectContaining({ description: 'X-ray — Chest', amountMinor: 750_000, sourceType: 'IMAGING_STUDY' })]);

    const record = (await as(doctor).get(`/patients/${patient.id}/record`)).body.data;
    expect(record.sections.imaging).toBe(true);
    expect(record.imaging).toEqual([expect.objectContaining({ id: s.id, status: 'PERFORMED', series: [expect.objectContaining({ description: 'PA chest' })] })]);
  });

  it('keeps what was recorded unchangeable and other organizations out', async () => {
    const { patient } = await visit();
    const s = (await as(doctor).post('/imaging/studies', chestXray(patient.id), key())).body.data;
    await study(s.id).perform(1);
    await as(radiologist).post(`/imaging/studies/${s.id}/report`, { findings: 'Clear.', impression: 'Normal.' }, ifMatch(2));
    const ctx = { organizationId: A.organizationId, userId: doctor.userId };
    await expect(withTenant(ctx, (tx) => tx.emrImagingStudy.updateMany({ where: { id: s.id }, data: { bodySite: 'Abdomen' } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.emrImagingReport.updateMany({ where: { studyId: s.id }, data: { impression: 'Edited' } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.emrImagingSeries.deleteMany({ where: { studyId: s.id } }))).rejects.toThrow();

    expect((await as(bDoctor).get('/imaging/studies')).body.data.items).toEqual([]);
    expect((await as(bDoctor).post(`/imaging/studies/${s.id}/cancel`, { reason: 'Not ours' }, ifMatch(3))).status).toBe(404);
    expect((await as(bDoctor).post('/imaging/studies', chestXray(patient.id), key())).body.error.code).toBe('PATIENT_NOT_FOUND');
  });
});
