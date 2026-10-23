// Labour & delivery and the birth register against real Postgres with RLS on: the antenatal link,
// server gestational age, stillbirth rules, corrections, notification numbers, registration with the
// civil registration number, certificate, permissions and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (n) => new Date(Date.now() - n * 3_600_000).toISOString();
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let doctor; let nurse; let desk; let admin; let bNurse;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const woman = async () => (await as(A).post('/patients', newPatient({ sex: 'FEMALE' }))).body.data;
const birth = (patientId, extra = {}) => ({
  patientId, bookingStatus: 'BOOKED', deliveredAt: hoursAgo(2), mode: 'SVD', motherStatus: 'ALIVE', bloodLossMl: 300,
  babySex: 'FEMALE', babyStatus: 'ALIVE', birthWeightKg: 3.1, apgar1: 8, apgar5: 10, breastfedWithinHour: true,
  nhmisIndicators: ['Labour monitored with partograph', 'Skin-to-skin within 1 hour'], conductedByUserId: nurse.userId, ...extra,
});
const deliver = (who, body) => as(who).post('/deliveries', body, key());

beforeAll(async () => {
  A = await createTenant('labA');
  B = await createTenant('labB');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  bNurse = await member(B, ['NURSE']);
});

describe('deliveries', () => {
  it('links her antenatal enrolment, takes gestational age from its LMP and closes it as delivered', async () => {
    const mother = await woman();
    const pregnancy = (await as(nurse).post('/antenatal', { patientId: mother.id, lmp: daysAgo(39 * 7 + 2), gravida: 1, parity: 0 }, key())).body.data;
    const recorded = await deliver(doctor, birth(mother.id, { gestationalWeeks: 30 }));
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body.data).toMatchObject({ pregnancyId: pregnancy.id, gestationalWeeks: 39, birthWeightKg: 3.1, conductedByName: expect.any(String), recordedByName: expect.any(String), registration: null });
    const after = (await as(nurse).get(`/antenatal?patientId=${mother.id}`)).body.data.items[0];
    expect(after).toMatchObject({ status: 'DELIVERED', closedByName: expect.any(String) });

    // A correction reopens the enrolment it closed.
    const marked = await as(nurse).post(`/deliveries/${recorded.body.data.id}/entered-in-error`, { reason: 'Recorded on the wrong mother' });
    expect(marked.status).toBe(200);
    expect(marked.body.data).toMatchObject({ status: 'ENTERED_IN_ERROR', erroredByName: expect.any(String) });
    expect((await as(nurse).get(`/antenatal?patientId=${mother.id}`)).body.data.items[0].status).toBe('ACTIVE');
  });

  it('needs a gestational age without an enrolment, and keeps stillbirths and live births apart', async () => {
    const mother = await woman();
    expect((await deliver(nurse, birth(mother.id))).status).toBe(400);
    const stillbirth = await deliver(nurse, birth(mother.id, { gestationalWeeks: 36, bookingStatus: 'UNBOOKED', babyStatus: 'FRESH_STILLBIRTH', apgar1: undefined, apgar5: undefined, breastfedWithinHour: false }));
    expect(stillbirth.status, JSON.stringify(stillbirth.body)).toBe(201);
    expect(stillbirth.body.data).toMatchObject({ pregnancyId: null, gestationalWeeks: 36, apgar1: null, apgar5: null });
    expect((await deliver(nurse, birth(mother.id, { gestationalWeeks: 36, babyStatus: 'MACERATED_STILLBIRTH' }))).status).toBe(400); // APGAR given
    expect((await deliver(nurse, birth(mother.id, { gestationalWeeks: 36, apgar5: undefined }))).status).toBe(400);
    expect((await deliver(nurse, birth(mother.id, { gestationalWeeks: 36, nhmisIndicators: ['Made-up indicator'] }))).status).toBe(400);
    expect((await deliver(nurse, birth(mother.id, { gestationalWeeks: 36, deliveredAt: new Date(Date.now() + 86_400_000).toISOString() }))).status).toBe(400);
    expect((await deliver(nurse, birth(mother.id, { gestationalWeeks: 36, conductedByUserId: desk.userId }))).status).toBe(400);
    // The "conducted by" picker lists colleagues who may record deliveries, not the front desk.
    const picker = (await as(nurse).get('/staff?permission=delivery.record')).body.data.items.map((p) => p.userId);
    expect(picker).toEqual(expect.arrayContaining([nurse.userId, doctor.userId]));
    expect(picker).not.toContain(desk.userId);
    // Only a live birth can be notified.
    expect((await as(nurse).post(`/deliveries/${stillbirth.body.data.id}/birth-notification`, { informantName: 'Mother', informantRelation: 'MOTHER' }, key())).status).toBe(409);
  });
});

describe('the birth register', () => {
  it('notifies once with a facility number, registers with the NPopC number, then records the certificate', async () => {
    const mother = await woman();
    const delivery = (await deliver(nurse, birth(mother.id, { gestationalWeeks: 40 }))).body.data;
    const notified = await as(nurse).post(`/deliveries/${delivery.id}/birth-notification`, { informantName: 'Ngozi Okafor', informantRelation: 'MOTHER', fatherName: 'Emeka Okafor' }, key());
    expect(notified.status, JSON.stringify(notified.body)).toBe(201);
    const entry = notified.body.data;
    expect(entry).toMatchObject({ status: 'NOTIFIED', notificationNumber: expect.stringMatching(new RegExp(`^BN-${new Date().getUTCFullYear()}-\\d{6}$`)), babyName: null, babySex: 'FEMALE', birthWeightKg: 3.1, notifiedByName: expect.any(String) });
    expect((await as(nurse).post(`/deliveries/${delivery.id}/birth-notification`, { informantName: 'Again', informantRelation: 'MOTHER' }, key())).status).toBe(409);
    // A notified birth's delivery record can no longer be marked in error.
    expect((await as(nurse).post(`/deliveries/${delivery.id}/entered-in-error`, { reason: 'Too late now' })).status).toBe(409);

    expect((await as(admin).post(`/births/${entry.id}/certificate`, {}, ifMatch(1))).status).toBe(409);
    const registered = await as(admin).post(`/births/${entry.id}/register`, { registrationNumber: 'LA/IKJ/2026/004521', babyName: 'Chiamaka Okafor' }, ifMatch(1));
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    expect(registered.body.data).toMatchObject({ status: 'REGISTERED', registrationNumber: 'LA/IKJ/2026/004521', babyName: 'Chiamaka Okafor', registeredByName: expect.any(String) });
    const issued = await as(admin).post(`/births/${entry.id}/certificate`, {}, ifMatch(2));
    expect(issued.body.data).toMatchObject({ status: 'CERTIFICATE_ISSUED', certificateIssuedByName: expect.any(String) });

    // Another birth cannot reuse that registration number.
    const second = (await deliver(nurse, birth((await woman()).id, { gestationalWeeks: 38 }))).body.data;
    const secondEntry = (await as(nurse).post(`/deliveries/${second.id}/birth-notification`, { informantName: 'Father', informantRelation: 'FATHER' }, key())).body.data;
    expect(Number(secondEntry.notificationNumber.slice(-6))).toBe(Number(entry.notificationNumber.slice(-6)) + 1);
    const reused = await as(nurse).post(`/births/${secondEntry.id}/register`, { registrationNumber: 'LA/IKJ/2026/004521' }, ifMatch(1));
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('REGISTRATION_NUMBER_IN_USE');

    const register = (await as(admin).get('/births')).body.data.items.map((row) => row.id);
    expect(register).toEqual(expect.arrayContaining([entry.id, secondEntry.id]));
  });

  it('keeps the front desk out, other hospitals out, and the database refuses edits', async () => {
    const delivery = (await deliver(nurse, birth((await woman()).id, { gestationalWeeks: 39 }))).body.data;
    expect((await as(desk).get('/deliveries')).status).toBe(403);
    expect((await deliver(admin, birth((await woman()).id, { gestationalWeeks: 39 }))).status).toBe(403);
    expect((await as(bNurse).get('/deliveries')).body.data.items.find((row) => row.id === delivery.id)).toBeUndefined();
    expect((await as(bNurse).post(`/deliveries/${delivery.id}/birth-notification`, { informantName: 'X', informantRelation: 'MOTHER' }, key())).status).toBe(404);
    // What was recorded never changes, and nothing is deleted (column grants on the request role).
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrDelivery.updateMany({ where: { id: delivery.id }, data: { birthWeightKg: 4 } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.emrDelivery.deleteMany({ where: { id: delivery.id } }))).rejects.toThrow();
  });
});
