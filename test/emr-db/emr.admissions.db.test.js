// Wards, beds, admissions and the MAR against real Postgres with RLS on.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const HOUR = 3_600_000;
const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let admin; let doctor; let nurse; let nurse2; let pharmacist; let reception; let bDoctor;
let general; let female; let bedsByCode;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

async function refreshBeds() {
  bedsByCode = {};
  for (const ward of [general, female]) {
    for (const bed of (await as(admin).get(`/wards/${ward.id}/beds`)).body.data.beds) bedsByCode[bed.code] = bed;
  }
  return bedsByCode;
}
async function visit(sex = 'FEMALE', who = doctor, tenant = A) {
  const patient = (await as(tenant).post('/patients', newPatient({ sex }))).body.data;
  const encounter = (await as(who).post('/encounters', { patientId: patient.id })).body.data;
  return { patient, encounter };
}
async function admitTo(bedCode, sex = 'FEMALE') {
  const { patient, encounter } = await visit(sex);
  const response = await as(doctor).post(`/encounters/${encounter.id}/admission`, { bedId: bedsByCode[bedCode].id, reason: 'Observation' });
  expect(response.status).toBe(201);
  return { patient, encounter, admission: response.body.data };
}
async function approvedLine(encounter, line) {
  const created = await as(doctor).post(`/encounters/${encounter.id}/prescriptions`, { items: [line] });
  expect(created.status).toBe(201);
  await as(pharmacist).post(`/pharmacy/prescriptions/${created.body.data.id}/approve`, {}, ifMatch(1));
  return created.body.data.items[0];
}
const chart = (admission, body, who = nurse, headers = key()) => as(who).post(`/admissions/${admission.id}/mar`, body, headers);
const given = (item, extra = {}) => ({ prescriptionItemId: item.id, status: 'GIVEN', dose: Number(item.dose), doseUnit: item.doseUnit, ...extra });
/** Moves an admission's start back in time so doses can be charted across a day (test setup only). */
const backdate = (admission, hours) => prisma.emrAdmission.update({ where: { id: admission.id }, data: { admittedAt: new Date(Date.now() - hours * HOUR) } });

beforeAll(async () => {
  A = await createTenant('admA');
  B = await createTenant('admB');
  admin = { ...A };
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  nurse2 = await member(A, ['NURSE']);
  pharmacist = await member(A, ['PHARMACIST']);
  reception = await member(A, ['RECEPTIONIST']);
  bDoctor = await member(B, ['DOCTOR']);
  general = (await as(admin).post('/wards', { code: 'GEN', name: 'General ward', kind: 'GENERAL', beds: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12'] })).body.data;
  female = (await as(admin).post('/wards', { code: 'FEM', name: 'Female medical', kind: 'GENERAL', genderRestriction: 'FEMALE', beds: ['F1', 'F2'] })).body.data;
  await refreshBeds();
});

describe('wards and beds', () => {
  it('admins manage wards; codes are unique; the census counts beds; other tenants see nothing', async () => {
    expect((await as(admin).post('/wards', { code: 'GEN', name: 'Again', kind: 'GENERAL' })).status).toBe(409);
    expect((await as(admin).post(`/wards/${female.id}/beds`, { codes: ['F1'] })).status).toBe(409);
    expect((await as(nurse).post('/wards', { code: 'ICU', name: 'ICU', kind: 'ICU' })).status).toBe(403);
    const icu = await as(admin).post('/wards', { code: 'icu', name: 'Intensive care', kind: 'ICU' });
    expect(icu.body.data.code).toBe('ICU');
    const added = await as(admin).post(`/wards/${icu.body.data.id}/beds`, { codes: ['I1', 'I2'] });
    expect(added.body.data.items).toHaveLength(2);
    const wards = (await as(reception).get('/wards')).body.data.items;
    expect(wards.find((w) => w.code === 'ICU').beds).toMatchObject({ AVAILABLE: 2, OCCUPIED: 0, total: 2 });
    expect((await as(bDoctor).get('/wards')).body.data.items).toHaveLength(0);
  });

  it('bed housekeeping follows its lifecycle and needs a reason to take a bed out of service', async () => {
    const bed = bedsByCode.G12;
    expect((await as(nurse).post(`/beds/${bed.id}/status`, { status: 'OUT_OF_SERVICE' }, ifMatch(bed.version))).status).toBe(400);
    const out = await as(nurse).post(`/beds/${bed.id}/status`, { status: 'OUT_OF_SERVICE', reason: 'Broken rail' }, ifMatch(bed.version));
    expect(out.body.data).toMatchObject({ status: 'OUT_OF_SERVICE', statusReason: 'Broken rail' });
    const { encounter } = await visit();
    expect((await as(doctor).post(`/encounters/${encounter.id}/admission`, { bedId: bed.id, reason: 'x' })).body.error.code).toBe('BED_NOT_AVAILABLE');
    const back = await as(nurse).post(`/beds/${bed.id}/status`, { status: 'AVAILABLE' }, ifMatch(out.body.data.version));
    expect(back.body.data).toMatchObject({ status: 'AVAILABLE', statusReason: null });
    expect((await as(reception).post(`/beds/${bed.id}/status`, { status: 'CLEANING' }, ifMatch(back.body.data.version))).status).toBe(403);
  });
});

describe('admit, transfer, discharge', () => {
  it('admits into an available bed and turns the visit into an inpatient stay', async () => {
    const { patient, encounter, admission } = await admitTo('G1');
    expect(admission).toMatchObject({ status: 'ADMITTED', patientId: patient.id, ward: { code: 'GEN' }, bed: { code: 'G1' } });
    const visitNow = (await as(doctor).get(`/encounters/${encounter.id}`)).body.data;
    expect(visitNow).toMatchObject({ class: 'INPATIENT', status: 'IN_PROGRESS' });
    expect((await refreshBeds()).G1.status).toBe('OCCUPIED');

    const { encounter: other } = await visit();
    const taken = await as(doctor).post(`/encounters/${other.id}/admission`, { bedId: bedsByCode.G1.id, reason: 'x' });
    expect(taken.body.error.code).toBe('BED_NOT_AVAILABLE');
    const secondVisit = (await as(doctor).post('/encounters', { patientId: patient.id }));
    expect(secondVisit.status).toBe(409); // one open visit per patient already
    expect((await as(nurse).post(`/encounters/${other.id}/admission`, { bedId: bedsByCode.G2.id, reason: 'x' })).status).toBe(403);
  });

  it('respects single-sex wards', async () => {
    const { encounter } = await visit('MALE');
    const refused = await as(doctor).post(`/encounters/${encounter.id}/admission`, { bedId: bedsByCode.F1.id, reason: 'Chest pain' });
    expect(refused.body.error.code).toBe('WARD_RESTRICTED');
  });

  it('two admissions racing for one bed: exactly one wins', async () => {
    const [one, two] = await Promise.all([visit(), visit()]);
    const results = await Promise.all([one, two].map(({ encounter }) => as(doctor).post(`/encounters/${encounter.id}/admission`, { bedId: bedsByCode.G3.id, reason: 'Race' })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.emrAdmission.count({ where: { bedId: bedsByCode.G3.id, status: 'ADMITTED' } })).toBe(1);
  });

  it('transfers keep a bed history, free the old bed for cleaning, and are versioned', async () => {
    const { admission } = await admitTo('G4');
    expect((await as(nurse).post(`/admissions/${admission.id}/transfer`, { bedId: bedsByCode.G4.id }, ifMatch(1))).status).toBe(400);
    expect((await as(nurse).post(`/admissions/${admission.id}/transfer`, { bedId: bedsByCode.G1.id }, ifMatch(1))).body.error.code).toBe('BED_NOT_AVAILABLE');
    const moved = await as(nurse).post(`/admissions/${admission.id}/transfer`, { bedId: bedsByCode.F2.id, note: 'Closer to nursing station' }, ifMatch(1));
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ version: 2, ward: { code: 'FEM' }, bed: { code: 'F2' } });
    expect((await as(nurse).post(`/admissions/${admission.id}/transfer`, { bedId: bedsByCode.G5.id }, ifMatch(1))).status).toBe(412);
    const beds = await refreshBeds();
    expect([beds.G4.status, beds.F2.status]).toEqual(['CLEANING', 'OCCUPIED']);
    const detail = (await as(doctor).get(`/admissions/${admission.id}`)).body.data;
    expect(detail.assignments.map((a) => [a.reason, a.bed.code, a.endedAt === null])).toEqual([['ADMISSION', 'G4', false], ['TRANSFER', 'F2', true]]);
    expect((await as(nurse).post(`/beds/${beds.F2.id}/status`, { status: 'CLEANING' }, ifMatch(beds.F2.version))).status).toBe(409);
  });

  it('discharge closes the stay and the visit; a death also closes the patient record', async () => {
    const { encounter, admission } = await admitTo('G6');
    expect((await as(nurse).post(`/admissions/${admission.id}/discharge`, { disposition: 'HOME', summary: 'Recovered well, home.' }, ifMatch(1))).status).toBe(403);
    expect((await as(doctor).post(`/admissions/${admission.id}/discharge`, { disposition: 'HOME', summary: 'short' }, ifMatch(1))).status).toBe(400);
    const done = await as(doctor).post(`/admissions/${admission.id}/discharge`, { disposition: 'HOME', summary: 'Recovered well, discharged home on oral medication.' }, ifMatch(1));
    expect(done.body.data).toMatchObject({ status: 'DISCHARGED', dischargeDisposition: 'HOME' });
    expect((await as(doctor).get(`/encounters/${encounter.id}`)).body.data.status).toBe('FINISHED');
    expect((await refreshBeds()).G6.status).toBe('CLEANING');
    expect((await as(nurse).post(`/admissions/${admission.id}/transfer`, { bedId: bedsByCode.G7.id }, ifMatch(2))).status).toBe(409);

    const died = await admitTo('G7');
    await as(doctor).post(`/admissions/${died.admission.id}/discharge`, { disposition: 'DECEASED', summary: 'Pronounced dead at 03:10 after cardiac arrest.' }, ifMatch(1));
    const patient = (await as(doctor).get(`/patients/${died.patient.id}`)).body.data;
    expect(patient).toMatchObject({ status: 'INACTIVE', deactivationReason: 'Deceased' });
  });

  it('an admission entered in error can be cancelled only while nothing is charted', async () => {
    const { admission } = await admitTo('G8');
    const cancelled = await as(doctor).post(`/admissions/${admission.id}/cancel`, { reason: 'Admitted the wrong patient' }, ifMatch(1));
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Admitted the wrong patient' });
    expect((await refreshBeds()).G8.status).toBe('CLEANING');
  });
});

describe('medication administration record', () => {
  it('charts only approved medicines from this stay, once per Idempotency-Key, never too soon', async () => {
    const { encounter, admission } = await admitTo('G9');
    const item = (await as(doctor).post(`/encounters/${encounter.id}/prescriptions`, { items: [{ drugCode: 'PARA500', dose: 1000, doseUnit: 'mg', frequency: 'QDS', durationDays: 3 }] })).body.data;
    const line = item.items[0];
    const notYet = await chart(admission, given(line));
    expect(notYet.body.error).toMatchObject({ code: 'ADMINISTRATION_NOT_ALLOWED', details: { rule: 'NOT_ACTIVE' } });
    await as(pharmacist).post(`/pharmacy/prescriptions/${item.id}/approve`, {}, ifMatch(1));

    expect((await as(nurse).post(`/admissions/${admission.id}/mar`, given(line))).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const headers = key();
    const first = await chart(admission, given(line), nurse, headers);
    expect(first.status).toBe(201);
    const replay = await chart(admission, given(line), nurse, headers);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await prisma.emrMedicationAdministration.count({ where: { admissionId: admission.id } })).toBe(1);

    const soon = await chart(admission, given(line));
    expect(soon.body.error.details).toMatchObject({ rule: 'TOO_SOON', nextAllowedAt: expect.any(String) });
    expect((await chart(admission, given(line, { dose: 1500 }))).body.error.details.rule).toBe('DOSE_ABOVE_PRESCRIBED');
    expect((await chart(admission, given(line, { dose: 1, doseUnit: 'g' }))).body.error.details.rule).toBe('DOSE_UNIT');
    expect((await chart(admission, { prescriptionItemId: line.id, status: 'HELD' })).status).toBe(400);
    expect((await chart(admission, { prescriptionItemId: line.id, status: 'HELD', reason: 'Nil by mouth for theatre' })).status).toBe(201);

    const view = (await as(doctor).get(`/admissions/${admission.id}/mar`)).body.data;
    expect(view.medicines[0]).toMatchObject({ drugCode: 'PARA500', givenLast24h: 1000, nextAllowedAt: expect.any(String) });
    expect(view.entries.map((e) => e.status).sort()).toEqual(['GIVEN', 'HELD']);
    expect((await as(reception).get(`/admissions/${admission.id}/mar`)).status).toBe(403);

    const { encounter: elsewhere } = await visit();
    const foreign = await approvedLine(elsewhere, { drugCode: 'OMEP20', dose: 20, doseUnit: 'mg', frequency: 'OD', durationDays: 5 });
    expect((await chart(admission, given(foreign))).status).toBe(400);
  });

  it('enforces the daily count, one-off STAT doses and the as-needed daily maximum', async () => {
    const { encounter, admission } = await admitTo('G10');
    await backdate(admission, 23);
    const qds = await approvedLine(encounter, { drugCode: 'PARA500', dose: 1000, doseUnit: 'mg', frequency: 'QDS', durationDays: 3 });
    for (const hours of [21, 16, 11, 6]) expect((await chart(admission, given(qds, { administeredAt: ago(hours) }))).status).toBe(201);
    const fifth = await chart(admission, given(qds));
    expect(fifth.body.error.details).toMatchObject({ rule: 'DAILY_COUNT', dosesInWindow: 4 });

    const stat = await approvedLine(encounter, { drugCode: 'CEFTRI1G_INJ', dose: 1, doseUnit: 'g', frequency: 'STAT' });
    expect((await chart(admission, given(stat, { route: 'IV' }))).status).toBe(201);
    expect((await chart(admission, given(stat, { route: 'IV' }))).body.error.details.rule).toBe('ALREADY_GIVEN');

    const prn = await approvedLine(encounter, { drugCode: 'IBU400', dose: 400, doseUnit: 'mg', frequency: 'PRN', prnReason: 'Pain', quantity: 20 });
    for (let i = 0; i < 6; i += 1) expect((await chart(admission, given(prn, { administeredAt: ago(6 - i) }))).status).toBe(201);
    expect((await chart(admission, given(prn))).body.error.details).toMatchObject({ rule: 'DAILY_MAXIMUM', givenLast24h: 2400, maxDailyDose: 2400 });
  });

  it('controlled medicines need a witness; mistakes are marked, not deleted', async () => {
    const { encounter, admission } = await admitTo('G11');
    const tram = await approvedLine(encounter, { drugCode: 'TRAM50', dose: 50, doseUnit: 'mg', frequency: 'BD', durationDays: 3 });
    expect((await chart(admission, given(tram))).body.error.code).toBe('WITNESS_REQUIRED');
    expect((await chart(admission, given(tram, { witnessUserId: reception.userId }))).body.error.code).toBe('WITNESS_REQUIRED');
    const witnessed = await chart(admission, given(tram, { witnessUserId: nurse2.userId }));
    expect(witnessed.body.data).toMatchObject({ status: 'GIVEN', witnessUserId: nurse2.userId, route: 'PO' });

    const url = `/admissions/${admission.id}/mar/${witnessed.body.data.id}/entered-in-error`;
    expect((await as(nurse).post(url, { reason: 'Charted against the wrong patient' })).body.data.entryStatus).toBe('ENTERED_IN_ERROR');
    expect((await as(nurse).post(url, { reason: 'Again' })).status).toBe(409);
    // With the mistaken entry out of the way, the real dose can be charted now.
    expect((await chart(admission, given(tram, { witnessUserId: nurse2.userId }))).status).toBe(201);
    expect((await as(doctor).post(`/admissions/${admission.id}/cancel`, { reason: 'Entered in error' }, ifMatch(1))).status).toBe(409);
  });

  it('two nurses charting the same dose at once: only one is recorded', async () => {
    const { encounter, admission } = await admitTo('G5');
    const line = await approvedLine(encounter, { drugCode: 'AMLO5', dose: 5, doseUnit: 'mg', frequency: 'OD', durationDays: 7 });
    const results = await Promise.all([chart(admission, given(line), nurse), chart(admission, given(line), nurse2)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.emrMedicationAdministration.count({ where: { admissionId: admission.id, status: 'GIVEN' } })).toBe(1);
  });
});

describe('database invariants and isolation', () => {
  it('the database refuses a second patient in a bed, history rewrites, MAR edits and cross-ward beds', async () => {
    const tenant = { organizationId: A.organizationId };
    const occupied = await prisma.emrAdmission.findFirst({ where: { organizationId: A.organizationId, status: 'ADMITTED' } });
    const { encounter } = await visit();
    await expect(withTenant(tenant, (tx) => tx.emrAdmission.create({
      data: { organizationId: A.organizationId, encounterId: encounter.id, patientId: encounter.patientId, wardId: occupied.wardId, bedId: occupied.bedId, reason: 'x', admittedByUserId: doctor.userId },
    }))).rejects.toThrow();
    await expect(withTenant(tenant, (tx) => tx.emrAdmission.create({
      data: { organizationId: A.organizationId, encounterId: encounter.id, patientId: encounter.patientId, wardId: female.id, bedId: bedsByCode.G12.id, reason: 'x', admittedByUserId: doctor.userId },
    }))).rejects.toThrow(); // G12 is not in the female ward
    const closed = await prisma.emrBedAssignment.findFirst({ where: { organizationId: A.organizationId, endedAt: { not: null } } });
    await expect(withTenant(tenant, (tx) => tx.emrBedAssignment.updateMany({ where: { id: closed.id }, data: { endedAt: new Date() } }))).rejects.toThrow();
    await expect(prisma.emrBedAssignment.delete({ where: { id: closed.id } })).rejects.toThrow();
    const entry = await prisma.emrMedicationAdministration.findFirst({ where: { organizationId: A.organizationId, status: 'GIVEN' } });
    await expect(withTenant(tenant, (tx) => tx.emrMedicationAdministration.updateMany({ where: { id: entry.id }, data: { dose: 9999 } }))).rejects.toThrow();
  });

  it('another organization cannot see, admit into, or chart on this hospital\'s beds and patients', async () => {
    const occupied = await prisma.emrAdmission.findFirst({ where: { organizationId: A.organizationId, status: 'ADMITTED' } });
    expect((await as(bDoctor).get(`/admissions/${occupied.id}`)).status).toBe(404);
    expect((await as(bDoctor).get('/admissions')).body.data.items).toHaveLength(0);
    expect((await as(bDoctor).get(`/wards/${general.id}/beds`)).status).toBe(404);
    const { encounter } = await visit('FEMALE', bDoctor, B);
    const intoA = await as(bDoctor).post(`/encounters/${encounter.id}/admission`, { bedId: bedsByCode.G12.id, reason: 'x' });
    expect(intoA.status).toBe(404);
    const charting = await as(bDoctor).post(`/admissions/${occupied.id}/mar`, { prescriptionItemId: randomUUID(), status: 'MISSED', reason: 'Not given' }, key());
    expect(charting.status).toBe(404);
    expect(charting.body.error.code).toBe('ADMISSION_NOT_FOUND');
  });
});

describe('visits and admissions stay consistent (review fixes)', () => {
  let obs;
  const obsBed = async (code) => {
    if (!obs) {
      const ward = (await as(admin).post('/wards', { code: 'OBS', name: 'Observation', kind: 'GENERAL', beds: ['O1', 'O2', 'O3', 'O4'] })).body.data;
      obs = Object.fromEntries((await as(admin).get(`/wards/${ward.id}/beds`)).body.data.beds.map((b) => [b.code, b]));
    }
    return obs[code];
  };

  it('a visit with a patient still in a bed cannot be finished or cancelled; discharge closes it', async () => {
    const { encounter } = await visit();
    const admission = (await as(doctor).post(`/encounters/${encounter.id}/admission`, { bedId: (await obsBed('O1')).id, reason: 'Observation' })).body.data;
    const { version } = (await as(doctor).get(`/encounters/${encounter.id}`)).body.data;
    const finish = await as(doctor).post(`/encounters/${encounter.id}/finish`, {}, ifMatch(version));
    const cancel = await as(doctor).post(`/encounters/${encounter.id}/cancel`, { reason: 'Patient left the ward' }, ifMatch(version));
    for (const refused of [finish, cancel]) {
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/admitted on this visit/);
    }
    await as(doctor).post(`/admissions/${admission.id}/discharge`, { disposition: 'HOME', summary: 'Observed overnight, well, discharged home.' }, ifMatch(1));
    expect((await as(doctor).get(`/encounters/${encounter.id}`)).body.data.status).toBe('FINISHED');
  });

  it('admitting and cancelling a visit at the same moment never leaves an admission on a cancelled visit', async () => {
    const { encounter } = await visit();
    const [admitted, cancelled] = await Promise.all([
      as(doctor).post(`/encounters/${encounter.id}/admission`, { bedId: (await obsBed('O2')).id, reason: 'Race' }),
      as(nurse).post(`/encounters/${encounter.id}/cancel`, { reason: 'Patient left before review' }, ifMatch(1)),
    ]);
    const final = await prisma.emrEncounter.findUnique({ where: { id: encounter.id } });
    const open = await prisma.emrAdmission.count({ where: { encounterId: encounter.id, status: 'ADMITTED' } });
    if (admitted.status === 201) {
      expect([409, 412]).toContain(cancelled.status);
      expect([final.status, open]).toEqual(['IN_PROGRESS', 1]);
    } else {
      expect(cancelled.status).toBe(200);
      expect(admitted.status).toBe(409);
      expect([final.status, open]).toEqual(['CANCELLED', 0]);
    }
  });

  it('no dose is charted on a discharged stay, even when both happen at once', async () => {
    const { encounter } = await visit();
    const admission = (await as(doctor).post(`/encounters/${encounter.id}/admission`, { bedId: (await obsBed('O3')).id, reason: 'Chest infection' })).body.data;
    const line = await approvedLine(encounter, { drugCode: 'AMOX500', dose: 500, doseUnit: 'mg', frequency: 'TDS', durationDays: 5 });
    const [charted, discharged] = await Promise.all([
      chart(admission, given(line)),
      as(doctor).post(`/admissions/${admission.id}/discharge`, { disposition: 'HOME', summary: 'Improving, completing antibiotics at home.' }, ifMatch(1)),
    ]);
    expect(discharged.status).toBe(200);
    expect([201, 409]).toContain(charted.status); // before the discharge, or refused — never a 500
    const late = await chart(admission, given(line));
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/discharged/);
  });
});
