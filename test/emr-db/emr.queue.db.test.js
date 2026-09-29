// Patient intake (server-issued MRNs, intake fields) and the station queue, on real Postgres.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, prisma } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let reception; let nurse; let nurse2; let doctor; let lab; let bNurse;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
let counter = 0;
const person = (extra = {}) => {
  counter += 1;
  return { givenName: 'Queue', familyName: `Patient${counter}`, dateOfBirth: '1985-03-02', sex: 'FEMALE', ...extra };
};
async function checkIn(who, patientBody = person(), visit = {}) {
  const patient = (await as(reception).post('/patients', patientBody)).body.data;
  const response = await as(who).post('/encounters', { patientId: patient.id, reason: 'Fever and cough', ...visit });
  expect(response.status).toBe(201);
  return { patient, encounter: response.body.data };
}

beforeAll(async () => {
  A = await createTenant('queueA');
  B = await createTenant('queueB');
  reception = await member(A, ['RECEPTIONIST']);
  nurse = await member(A, ['NURSE']);
  nurse2 = await member(A, ['NURSE']);
  doctor = await member(A, ['DOCTOR']);
  lab = await member(A, ['LAB_SCIENTIST']);
  bNurse = await member(B, ['NURSE']);
});

describe('patient intake', () => {
  it('issues consecutive MRNs per organization and stores the full intake form', async () => {
    const first = await as(reception).post('/patients', person({
      preferredName: 'Bimpe', payer: 'NHIS', category: 'ADULT', hospitalNumber: 'old/2019/441', language: 'Yoruba', occupation: 'Trader',
      bloodGroup: 'O+', addressWard: 'Ward 4', emergencyContactName: 'Tunde Ade', emergencyContactPhone: '+2348030000000', emergencyContactRelationship: 'Brother',
    }));
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ medicalRecordNumber: 'MRN-0000001', hospitalNumber: 'OLD/2019/441', payer: 'NHIS', bloodGroup: 'O+', emergencyContactName: 'Tunde Ade' });
    const second = await as(reception).post('/patients', person());
    expect(second.body.data.medicalRecordNumber).toBe('MRN-0000002');
    const inB = await as({ ...B }).post('/patients', person());
    expect(inB.body.data.medicalRecordNumber).toBe('MRN-0000001'); // numbering is per organization

    expect((await as(reception).post('/patients', person({ hospitalNumber: 'OLD/2019/441' }))).body.error.code).toBe('HOSPITAL_NUMBER_IN_USE');
    expect((await as(reception).post('/patients', person({ bloodGroup: 'Z+' }))).status).toBe(400);
    const imported = await as(reception).post('/patients', person({ medicalRecordNumber: 'LEGACY-7788' }));
    expect(imported.body.data.medicalRecordNumber).toBe('LEGACY-7788');

    const found = await as(reception).get('/patients?q=old/2019');
    expect(found.body.data.items.map((p) => p.id)).toEqual([first.body.data.id]);
  });

  it('skips an MRN already taken by a hand-entered number', async () => {
    const tenant = await createTenant('queueC');
    const clerk = await member(tenant, ['RECEPTIONIST']);
    await as(clerk).post('/patients', person({ medicalRecordNumber: 'MRN-0000001' }));
    expect((await as(clerk).post('/patients', person())).body.data.medicalRecordNumber).toBe('MRN-0000002');
  });
});

describe('station queue', () => {
  it('check-in puts the patient in the queue; the queue shows who is waiting where', async () => {
    const { patient, encounter } = await checkIn(reception);
    expect(encounter.queueEntry).toMatchObject({ station: 'Vital', priority: 'NORMAL', status: 'WAITING', version: 1 });
    const vitals = (await as(nurse).get('/queue?station=Vital')).body.data.items;
    const entry = vitals.find((e) => e.encounterId === encounter.id);
    expect(entry).toMatchObject({ complaint: 'Fever and cough', waitMinutes: 0, patient: { id: patient.id, medicalRecordNumber: patient.medicalRecordNumber } });
    expect(entry.patient).not.toHaveProperty('phone');
  });

  it('call-next takes the most urgent, then the longest waiting — and says when nobody is waiting', async () => {
    const station = 'Immunization';
    const normal = await checkIn(reception, person(), { station });
    const urgent = await checkIn(reception, person(), { station, priority: 'URGENT' });
    const emergency = await checkIn(reception, person(), { station, priority: 'EMERGENCY' });
    const order = [];
    for (let i = 0; i < 3; i += 1) {
      const called = await as(nurse).post('/queue/call-next', { station });
      expect(called.body.data).toMatchObject({ status: 'IN_PROGRESS', assignedToUserId: nurse.userId });
      order.push(called.body.data.encounterId);
    }
    expect(order).toEqual([emergency, urgent, normal].map((v) => v.encounter.id));
    const none = await as(nurse).post('/queue/call-next', { station });
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('NOTHING_WAITING');
  });

  it('two nurses pressing call-next at once always get different patients', async () => {
    const station = 'Nutrition';
    await checkIn(reception, person(), { station });
    await checkIn(reception, person(), { station });
    const [one, two] = await Promise.all([as(nurse).post('/queue/call-next', { station }), as(nurse2).post('/queue/call-next', { station })]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body.data.id).not.toBe(two.body.data.id);
  });

  it('moves patients between stations with versions, and keeps a full history', async () => {
    const { encounter } = await checkIn(reception);
    const entryId = encounter.queueEntry.id;
    const taken = await as(nurse).patch(`/queue/${entryId}`, { status: 'IN_PROGRESS' }, ifMatch(1));
    expect(taken.body.data).toMatchObject({ status: 'IN_PROGRESS', assignedToUserId: nurse.userId, version: 2 });
    const moved = await as(nurse).patch(`/queue/${entryId}`, { station: 'Consultation', priority: 'URGENT' }, ifMatch(2));
    expect(moved.body.data).toMatchObject({ station: 'Consultation', status: 'WAITING', priority: 'URGENT', calledAt: null, assignedToUserId: null });
    expect((await as(nurse).patch(`/queue/${entryId}`, { station: 'Lab' }, ifMatch(2))).status).toBe(412);
    expect((await as(nurse).patch(`/queue/${entryId}`, { station: 'Nowhere' }, ifMatch(3))).status).toBe(400);
    const events = (await as(doctor).get(`/queue/${entryId}/history`)).body.data.items;
    expect(events.map((e) => [e.action, e.station, e.status])).toEqual([
      ['CHECKED_IN', 'Vital', 'WAITING'], ['CALLED', 'Vital', 'IN_PROGRESS'], ['MOVED', 'Consultation', 'WAITING'],
    ]);
  });

  it('a finished or cancelled visit leaves the queue', async () => {
    const done = await checkIn(reception, person(), { station: 'Consultation' });
    await as(doctor).post(`/encounters/${done.encounter.id}/start`, {}, ifMatch(1));
    await as(doctor).post(`/encounters/${done.encounter.id}/finish`, {}, ifMatch(2));
    const gone = await checkIn(reception, person(), { station: 'Consultation' });
    await as(nurse).post(`/encounters/${gone.encounter.id}/cancel`, { reason: 'Left before consultation' }, ifMatch(1));
    const ids = (await as(nurse).get('/queue?station=Consultation')).body.data.items.map((e) => e.encounterId);
    expect(ids).not.toContain(done.encounter.id);
    expect(ids).not.toContain(gone.encounter.id);
    const entry = await prisma.emrQueueEntry.findFirst({ where: { encounterId: done.encounter.id } });
    expect(entry.status).toBe('COMPLETED');
    expect((await as(nurse).patch(`/queue/${entry.id}`, { station: 'Lab' }, ifMatch(entry.version))).status).toBe(409);
  });

  it('lab staff work the queue; admins only look; other hospitals see nothing', async () => {
    const { encounter } = await checkIn(reception, person(), { station: 'Lab' });
    expect((await as(lab).post('/queue/call-next', { station: 'Lab' })).status).toBe(200);
    expect((await as({ ...A }).get('/queue')).status).toBe(200);
    expect((await as({ ...A }).post('/queue/call-next', { station: 'Lab' })).status).toBe(403);
    expect((await as(bNurse).get('/queue')).body.data.items).toHaveLength(0);
    expect((await as(bNurse).patch(`/queue/${encounter.queueEntry.id}`, { priority: 'URGENT' }, ifMatch(2))).status).toBe(404);
    await checkIn(reception, person(), { station: 'Delivery' });
    expect((await as(bNurse).post('/queue/call-next', { station: 'Delivery' })).status).toBe(404);
  });
});
