// Appointment requests from the Sabi patient app, worked from the EMR desk, against real Postgres
// with RLS on: the requests are made the way the patient app stores them (hospital_appointments,
// with an ACTIVE enrollment), then confirmed or rejected through the EMR API.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const MIN = 60_000;
const short = () => randomUUID().slice(0, 8);
const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let desk; let doctor; let admin; let bDesk; let noLinkDesk;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const register = async (overrides) => (await as(desk).post('/patients', newPatient(overrides))).body.data;
const confirm = (requestId, body = {}, who = desk, headers = key()) => as(who).post(`/appointments/requests/${requestId}/confirm`, body, headers);
const reject = (requestId, body, who = desk) => as(who).post(`/appointments/requests/${requestId}/reject`, body);
const stored = (id) => prisma.hospitalAppointment.findUnique({ where: { id } });

/** A Sabi patient-app account enrolled (ACTIVE) with the tenant's hospital; optionally with a dependent enrolled too. */
async function enrolledAccount(tenant, { dependent = false } = {}) {
  const tag = short();
  const account = await prisma.user.create({
    data: { patientId: `SABI-AR-${tag}`, email: `requester-${tag}@emr.test`, password: 'x', full_name: `Requester ${tag}`, phone_number: '+2348000000000', dob: new Date('1988-03-04'), accountStatus: 'ACTIVE' },
  });
  const plan = await prisma.hospitalMemberPlan.create({ data: { hospitalId: tenant.facilityId, name: `Plan ${tag}`, description: 'Test', feeMinor: 0 } });
  await prisma.hospitalEnrollment.create({ data: { patientId: account.id, hospitalId: tenant.facilityId, planId: plan.id, status: 'ACTIVE' } });
  if (!dependent) return { account };
  const child = await prisma.dependentProfile.create({ data: { patientId: account.id, fullName: `Child ${tag}`, dateOfBirth: new Date('2019-06-01'), gender: 'Female' } });
  await prisma.hospitalEnrollment.create({ data: { patientId: account.id, dependentId: child.id, hospitalId: tenant.facilityId, planId: plan.id, status: 'ACTIVE' } });
  return { account, child };
}

/** A visit request as the patient app makes it. */
async function requestVisit(tenant, account, { minutes = 24 * 60, dependentId = null, appointmentType = 'Consultation', reason = 'Headaches' } = {}) {
  const enrollment = await prisma.hospitalEnrollment.findFirst({ where: { patientId: account.id, hospitalId: tenant.facilityId, dependentId } });
  return prisma.hospitalAppointment.create({
    data: {
      patientId: account.id, dependentId, hospitalId: tenant.facilityId, enrollmentId: enrollment.id, status: 'PENDING',
      requestedAt: new Date(Math.round((Date.now() + minutes * MIN) / 1000) * 1000), appointmentType, reason,
    },
  });
}

const listed = async (who, query = '') => (await as(who).get(`/appointments/requests${query}`)).body.data.items;

beforeAll(async () => {
  A = await createTenant('reqA');
  B = await createTenant('reqB');
  desk = await member(A, ['RECEPTIONIST']);
  doctor = await member(A, ['DOCTOR']);
  admin = { ...A };
  bDesk = await member(B, ['RECEPTIONIST']);
  // A role that may book but not update patient records (roles are configurable per deployment).
  const role = await prisma.accessRole.create({
    data: { code: `TEST_BOOKER_${short().toUpperCase()}`, scope: 'ORGANIZATION', permissions: { create: [{ permissionCode: 'appointment.read' }, { permissionCode: 'appointment.manage' }] } },
  });
  noLinkDesk = await member(A, [role.code]);
});

describe('the desk sees its own hospital’s requests', () => {
  it('lists pending requests with who asked and their linked record, and keeps other hospitals out', async () => {
    const { account } = await enrolledAccount(A);
    const record = await register();
    expect((await as(admin).post(`/patients/${record.id}/link-account`, { userId: account.id }, ifMatch(1))).status).toBe(200);
    const mine = await requestVisit(A, account, { appointmentType: 'Follow-up', reason: 'BP review' });
    const { account: other } = await enrolledAccount(B);
    const theirs = await requestVisit(B, other);

    const items = await listed(desk);
    const item = items.find((row) => row.id === mine.id);
    expect(item).toMatchObject({
      status: 'PENDING', appointmentType: 'Follow-up', reason: 'BP review', suggestedType: 'FOLLOW_UP', appointmentId: null, dependent: null,
      requester: { userId: account.id, name: account.full_name, phone: '+2348000000000', dateOfBirth: '1988-03-04' },
      linkedPatient: { id: record.id, medicalRecordNumber: record.medicalRecordNumber },
    });
    expect(new Date(item.requestedAt).getTime()).toBe(mine.requestedAt.getTime());
    expect(items.map((row) => row.id)).not.toContain(theirs.id);
    expect((await listed(bDesk)).map((row) => row.id)).toEqual([theirs.id]);
    // Read-only staff can see the list; staff without appointment access cannot.
    expect((await listed(admin)).map((row) => row.id)).toContain(mine.id);
    const finance = await member(A, ['FINANCE_OFFICER']);
    expect((await as(finance).get('/appointments/requests')).status).toBe(403);

    // Another hospital's request cannot be decided, and is left as it was.
    expect((await confirm(theirs.id)).body.error.code).toBe('APPOINTMENT_REQUEST_NOT_FOUND');
    expect((await reject(theirs.id, { reason: 'Not ours' })).body.error.code).toBe('APPOINTMENT_REQUEST_NOT_FOUND');
    expect((await stored(theirs.id)).status).toBe('PENDING');
    // In the database itself: the tenant's view of requests holds only its own hospital's.
    const seen = await withTenant({ organizationId: A.organizationId, userId: desk.userId }, (tx) => tx.$queryRaw`SELECT "id", "hospital_id" FROM "emr_appointment_requests"`);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((row) => row.hospital_id === A.facilityId)).toBe(true);
    await expect(withTenant({ organizationId: A.organizationId, userId: desk.userId }, (tx) => tx.$executeRaw`UPDATE "emr_appointment_requests" SET "reason" = 'changed' WHERE "id" = ${mine.id}`)).rejects.toThrow();
    await expect(withTenant({ organizationId: A.organizationId, userId: desk.userId }, (tx) => tx.$queryRaw`SELECT "id" FROM "hospital_appointments" LIMIT 1`)).rejects.toThrow();
  });
});

describe('confirming', () => {
  it('books a linked patient for the requested time, once, and the patient app shows it scheduled', async () => {
    const { account } = await enrolledAccount(A);
    const record = await register();
    await as(admin).post(`/patients/${record.id}/link-account`, { userId: account.id }, ifMatch(1));
    const asked = await requestVisit(A, account, { appointmentType: 'Follow-up', reason: 'BP review' });

    const headers = key();
    const confirmed = await confirm(asked.id, { providerUserId: doctor.userId }, desk, headers);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.request).toMatchObject({ id: asked.id, status: 'SCHEDULED', appointmentId: confirmed.body.data.appointment.id });
    expect(confirmed.body.data.appointment).toMatchObject({
      patientId: record.id, type: 'FOLLOW_UP', reason: 'Follow-up — BP review', status: 'SCHEDULED', requestId: asked.id,
      providerUserId: doctor.userId, bookedByUserId: desk.userId,
    });
    expect(new Date(confirmed.body.data.appointment.scheduledAt).getTime()).toBe(asked.requestedAt.getTime());
    expect(await stored(asked.id)).toMatchObject({ status: 'SCHEDULED', decidedByUserId: desk.userId, decidedAt: expect.any(Date) });

    // A retry with the same key replays; a second decision is refused.
    const replay = await confirm(asked.id, { providerUserId: doctor.userId }, desk, headers);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.appointment.id).toBe(confirmed.body.data.appointment.id);
    expect((await confirm(asked.id)).body.error.code).toBe('INVALID_STATE');
    expect((await reject(asked.id, { reason: 'Changed our mind' })).body.error.code).toBe('INVALID_STATE');

    // The booking is on the desk's list and the request records it.
    const bookings = (await as(desk).get(`/appointments?patientId=${record.id}`)).body.data.items;
    expect(bookings.map((row) => row.id)).toEqual([confirmed.body.data.appointment.id]);
    expect((await listed(desk, '?status=SCHEDULED')).find((row) => row.id === asked.id)).toMatchObject({ appointmentId: confirmed.body.data.appointment.id, decidedByName: expect.any(String) });
    const audit = await withTenant({ organizationId: A.organizationId, userId: desk.userId }, (tx) => tx.emrAuditEvent.findMany({ where: { resourceId: asked.id } }));
    expect(audit.map((row) => row.action)).toEqual(['appointment_request.confirmed']);

    // Read-only staff cannot confirm.
    const another = await requestVisit(A, account, { minutes: 48 * 60 });
    expect((await confirm(another.id, {}, admin)).status).toBe(403);
  });

  it('needs the desk to find or register an unlinked patient, then links their record', async () => {
    const { account } = await enrolledAccount(A);
    const asked = await requestVisit(A, account);
    const match = await confirm(asked.id);
    expect(match.status).toBe(409);
    expect(match.body.error.code).toBe('PATIENT_MATCH_REQUIRED');
    expect((await stored(asked.id)).status).toBe('PENDING'); // nothing was decided

    // A record already linked to someone else is refused.
    const { account: someoneElse } = await enrolledAccount(A);
    const theirRecord = await register();
    await as(admin).post(`/patients/${theirRecord.id}/link-account`, { userId: someoneElse.id }, ifMatch(1));
    expect((await confirm(asked.id, { patientId: theirRecord.id })).body.error.code).toBe('PATIENT_ALREADY_LINKED');
    // Staff who may book but not update patient records cannot make the link.
    const record = await register({ givenName: 'Registered', familyName: `AtDesk${short()}` });
    expect((await confirm(asked.id, { patientId: record.id }, noLinkDesk)).status).toBe(403);

    const confirmed = await confirm(asked.id, { patientId: record.id, type: 'SPECIALIST' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.appointment).toMatchObject({ patientId: record.id, type: 'SPECIALIST', reason: 'Consultation — Headaches' });
    const linked = (await as(desk).get(`/patients/${record.id}`)).body.data;
    expect(linked).toMatchObject({ linkedUserId: account.id, version: 2 });

    // The next request from the same account finds the record by itself.
    const next = await requestVisit(A, account, { minutes: 72 * 60 });
    expect((await listed(desk)).find((row) => row.id === next.id).linkedPatient).toMatchObject({ id: record.id });
    expect((await confirm(next.id, { patientId: theirRecord.id })).body.error.code).toBe('PATIENT_ALREADY_LINKED');
    expect((await confirm(next.id)).status).toBe(200);
  });

  it('cannot link a patient without an active enrollment', async () => {
    const { account } = await enrolledAccount(A);
    const asked = await requestVisit(A, account);
    await prisma.hospitalEnrollment.updateMany({ where: { patientId: account.id }, data: { status: 'REJECTED' } });
    const refused = await confirm(asked.id, { patientId: (await register()).id });
    expect(refused.body.error).toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('enrollment') });
    expect((await reject(asked.id, { reason: 'No longer enrolled' })).status).toBe(200);
  });

  it('books a dependent’s visit on the record the desk chooses, without linking it', async () => {
    const { account, child } = await enrolledAccount(A, { dependent: true });
    const parentRecord = await register();
    await as(admin).post(`/patients/${parentRecord.id}/link-account`, { userId: account.id }, ifMatch(1));
    const asked = await requestVisit(A, account, { dependentId: child.id, appointmentType: 'Check-up', reason: 'Vaccines due' });

    const item = (await listed(desk)).find((row) => row.id === asked.id);
    expect(item).toMatchObject({ linkedPatient: null, dependent: { id: child.id, fullName: child.fullName, dateOfBirth: '2019-06-01', gender: 'Female' } });
    expect((await confirm(asked.id)).body.error.code).toBe('PATIENT_MATCH_REQUIRED');
    expect((await confirm(asked.id, { patientId: parentRecord.id })).body.error.code).toBe('PATIENT_ALREADY_LINKED');

    const childRecord = await register({ givenName: 'Child', dateOfBirth: '2019-06-01' });
    const confirmed = await confirm(asked.id, { patientId: childRecord.id, type: 'IMMUNIZATION' });
    expect(confirmed.body.data.appointment).toMatchObject({ patientId: childRecord.id, type: 'IMMUNIZATION' });
    expect((await as(desk).get(`/patients/${childRecord.id}`)).body.data).toMatchObject({ linkedUserId: null, version: 1 });
  });

  it('refuses a request whose time has passed', async () => {
    const { account } = await enrolledAccount(A);
    const record = await register();
    await as(admin).post(`/patients/${record.id}/link-account`, { userId: account.id }, ifMatch(1));
    const late = await requestVisit(A, account, { minutes: -60 });
    expect((await confirm(late.id)).body.error).toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('passed') });
    expect((await stored(late.id)).status).toBe('PENDING');
  });
});

describe('rejecting', () => {
  it('records the hospital’s reason for the patient, once', async () => {
    const { account } = await enrolledAccount(A);
    const asked = await requestVisit(A, account);
    expect((await reject(asked.id, {})).status).toBe(400);
    expect((await reject(asked.id, { reason: 'Clinic closed' }, admin)).status).toBe(403);
    const rejected = await reject(asked.id, { reason: 'Clinic closed that day' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({ id: asked.id, status: 'REJECTED', decisionReason: 'Clinic closed that day' });
    expect(await stored(asked.id)).toMatchObject({ status: 'REJECTED', decisionReason: 'Clinic closed that day', decidedByUserId: desk.userId });
    expect((await reject(asked.id, { reason: 'Again' })).body.error.code).toBe('INVALID_STATE');
    expect((await confirm(asked.id)).body.error.code).toBe('INVALID_STATE');
    expect((await listed(desk)).map((row) => row.id)).not.toContain(asked.id);
    expect((await listed(desk, '?status=REJECTED')).find((row) => row.id === asked.id)).toMatchObject({ decisionReason: 'Clinic closed that day' });
  });
});

describe('after confirming', () => {
  it('passes the desk’s check-in and cancellation back to the patient’s request', async () => {
    const { account } = await enrolledAccount(A);
    const record = await register();
    await as(admin).post(`/patients/${record.id}/link-account`, { userId: account.id }, ifMatch(1));
    const today = await requestVisit(A, account, { minutes: 30 });
    const later = await requestVisit(A, account, { minutes: 5 * 24 * 60 });
    const first = (await confirm(today.id)).body.data.appointment;
    const second = (await confirm(later.id)).body.data.appointment;

    expect((await as(desk).post(`/appointments/${first.id}/check-in`, {}, ifMatch(1))).status).toBe(200);
    expect(await stored(today.id)).toMatchObject({ status: 'CHECKED_IN', checkedInAt: expect.any(Date) });
    expect((await as(desk).post(`/appointments/${second.id}/cancel`, { reason: 'Doctor on leave' }, ifMatch(1))).status).toBe(200);
    expect(await stored(later.id)).toMatchObject({ status: 'CANCELLED', decisionReason: 'Doctor on leave' });
  });
});
