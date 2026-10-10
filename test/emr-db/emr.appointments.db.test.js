// Hospital appointments against real Postgres with RLS on.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const MIN = 60_000;
const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const at = (minutesFromNow) => new Date(Date.now() + minutesFromNow * MIN).toISOString();
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let desk; let doctor; let nurse; let finance; let bDesk;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const patient = async () => (await as(A).post('/patients', newPatient())).body.data;
const book = (body, who = desk, headers = key()) => as(who).post('/appointments', body, headers);

beforeAll(async () => {
  A = await createTenant('apptA');
  B = await createTenant('apptB');
  desk = await member(A, ['RECEPTIONIST']);
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  finance = await member(A, ['FINANCE_OFFICER']);
  bDesk = await member(B, ['RECEPTIONIST']);
});

describe('booking', () => {
  it('books a patient with a clinician, once per time slot, never in the past', async () => {
    const p = await patient();
    const headers = key();
    const booked = await book({ patientId: p.id, scheduledAt: at(120), type: 'FOLLOW_UP', providerUserId: doctor.userId, reason: 'BP review' }, desk, headers);
    expect(booked.status).toBe(201);
    expect(booked.body.data).toMatchObject({ status: 'SCHEDULED', type: 'FOLLOW_UP', reason: 'BP review', providerName: expect.any(String), bookedByName: expect.any(String), version: 1 });
    expect(booked.body.data.patient).toMatchObject({ id: p.id, medicalRecordNumber: p.medicalRecordNumber });
    // A retried request with the same key returns the same booking.
    const replay = await book({ patientId: p.id, scheduledAt: booked.body.data.scheduledAt, type: 'FOLLOW_UP', providerUserId: doctor.userId, reason: 'BP review' }, desk, headers);
    expect(replay.body.data.id).toBe(booked.body.data.id);

    expect((await book({ patientId: p.id, scheduledAt: booked.body.data.scheduledAt })).body.error.code).toBe('APPOINTMENT_CONFLICT');
    expect((await book({ patientId: p.id, scheduledAt: at(-60) })).status).toBe(400);
    expect((await book({ patientId: p.id, scheduledAt: at(60), providerUserId: desk.userId })).status).toBe(400); // not a clinician
    expect((await book({ patientId: p.id, scheduledAt: at(60) }, finance)).status).toBe(403);
    expect((await book({ patientId: p.id, scheduledAt: '2026-13-01T09:00:00Z' })).status).toBe(400);

    const listed = (await as(nurse).get(`/appointments?patientId=${p.id}`)).body.data.items;
    expect(listed.map((a) => a.id)).toEqual([booked.body.data.id]);
  });
});

describe('the day of the appointment', () => {
  it('check-in opens a visit with the provider attending and queues the patient by type', async () => {
    const p = await patient();
    const appt = (await book({ patientId: p.id, scheduledAt: at(10), type: 'ANC', providerUserId: doctor.userId })).body.data;
    const checked = await as(desk).post(`/appointments/${appt.id}/check-in`, {}, ifMatch(1));
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ status: 'ATTENDED', checkedInByName: expect.any(String), encounterId: expect.any(String) });
    const visit = (await as(doctor).get(`/encounters/${checked.body.data.encounterId}`)).body.data;
    expect(visit).toMatchObject({ source: 'APPOINTMENT', sourceReference: appt.id, attendingUserId: doctor.userId, reason: 'Antenatal appointment', status: 'ARRIVED' });
    const queue = (await as(desk).get('/queue')).body.data.items.find((e) => e.encounterId === visit.id);
    expect(queue).toMatchObject({ station: 'ANC', status: 'WAITING' });
    expect((await as(desk).post(`/appointments/${appt.id}/check-in`, {}, ifMatch(2))).status).toBe(409);
  });

  it('reuses the visit of a patient who already walked in, and refuses a check-in days early', async () => {
    const p = await patient();
    const walkIn = (await as(desk).post('/encounters', { patientId: p.id, reason: 'Walked in early' })).body.data;
    const appt = (await book({ patientId: p.id, scheduledAt: at(30), providerUserId: nurse.userId })).body.data;
    const checked = (await as(desk).post(`/appointments/${appt.id}/check-in`, {}, ifMatch(1))).body.data;
    expect(checked.encounterId).toBe(walkIn.id);
    const entries = (await as(desk).get('/queue')).body.data.items.filter((e) => e.patientId === p.id);
    expect(entries).toHaveLength(1);

    const later = (await book({ patientId: p.id, scheduledAt: at(3 * 24 * 60) })).body.data;
    expect((await as(desk).post(`/appointments/${later.id}/check-in`, {}, ifMatch(1))).body.error.code).toBe('INVALID_STATE');
  });

  it('marks a no-show only once the time has passed, and a cancellation frees the slot', async () => {
    const p = await patient();
    const soon = (await book({ patientId: p.id, scheduledAt: at(45) })).body.data;
    expect((await as(desk).post(`/appointments/${soon.id}/no-show`, {}, ifMatch(1))).body.error.code).toBe('INVALID_STATE');
    const due = (await book({ patientId: p.id, scheduledAt: at(-2) })).body.data;
    const missed = await as(desk).post(`/appointments/${due.id}/no-show`, {}, ifMatch(1));
    expect(missed.body.data).toMatchObject({ status: 'NO_SHOW', noShowByName: expect.any(String) });

    expect((await as(desk).post(`/appointments/${soon.id}/cancel`, {}, ifMatch(1))).status).toBe(400);
    const cancelled = await as(desk).post(`/appointments/${soon.id}/cancel`, { reason: 'Patient travelling' }, ifMatch(1));
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Patient travelling' });
    expect((await book({ patientId: p.id, scheduledAt: soon.scheduledAt })).status).toBe(201);
    // Stale versions are refused.
    expect((await as(desk).post(`/appointments/${soon.id}/cancel`, { reason: 'Again' }, ifMatch(1))).status).toBe(409);
  });
});

describe('around the hospital', () => {
  it('shows due follow-ups on the dashboard and appointments on the patient record', async () => {
    const p = await patient();
    const followUp = (await book({ patientId: p.id, scheduledAt: at(5), type: 'FOLLOW_UP', reason: 'Diabetes review' })).body.data;
    const day = new Date(); day.setHours(0, 0, 0, 0); const month = new Date(day); month.setDate(1);
    const board = (await as(doctor).get(`/dashboard?since=${encodeURIComponent(day.toISOString())}&monthStart=${encodeURIComponent(month.toISOString())}`)).body.data;
    expect(board.work.followUpsDue).toEqual(expect.arrayContaining([expect.objectContaining({ id: followUp.id, reason: 'Diabetes review', patient: expect.objectContaining({ id: p.id }) })]));
    const record = (await as(doctor).get(`/patients/${p.id}/record`)).body.data;
    expect(record.sections.appointments).toBe(true);
    expect(record.appointments).toEqual([expect.objectContaining({ id: followUp.id, type: 'FOLLOW_UP' })]);
  });

  it('keeps what was booked unchangeable and other organizations out', async () => {
    const p = await patient();
    const appt = (await book({ patientId: p.id, scheduledAt: at(90) })).body.data;
    const ctx = { organizationId: A.organizationId, userId: desk.userId };
    await expect(withTenant(ctx, (tx) => tx.emrAppointment.updateMany({ where: { id: appt.id }, data: { scheduledAt: new Date() } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.emrAppointment.deleteMany({ where: { id: appt.id } }))).rejects.toThrow();
    // An attended appointment must point at its visit (database check).
    await expect(withTenant(ctx, (tx) => tx.emrAppointment.updateMany({ where: { id: appt.id }, data: { status: 'ATTENDED' } }))).rejects.toThrow();

    expect((await as(bDesk).get('/appointments')).body.data.items).toEqual([]);
    expect((await as(bDesk).post(`/appointments/${appt.id}/cancel`, { reason: 'Not ours' }, ifMatch(1))).status).toBe(404);
    expect((await as(bDesk).post('/appointments', { patientId: p.id, scheduledAt: at(60) }, key())).body.error.code).toBe('PATIENT_NOT_FOUND');
  });
});
