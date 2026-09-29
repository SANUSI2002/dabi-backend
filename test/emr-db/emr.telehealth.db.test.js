// UC-2: telemedicine → EMR handoff, end to end on a real database. The telemedicine module's own
// complete() publishes the event; the EMR worker turns it into exactly one encounter or a
// recorded reason why not.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { complete } from '../../src/modules/doctor-appointments/doctor-appointments.service.js';
import { processTelehealthHandoffs } from '../../src/modules/emr/telehealth/telehealth.handoff.js';
import { addMember, createTenant, newPatient, prisma, tokenFor } from './fixtures.js';

const base = (tenant) => `/api/v1/emr/organizations/${tenant.organizationId}`;
let A; let B; let doctor; let doctorInB; let nurse;

async function patientAccount() {
  const tag = randomUUID().slice(0, 8);
  return prisma.user.create({ data: { patientId: `SABI-TP-${tag}`, email: `tele-${tag}@emr.test`, password: 'x', accountStatus: 'ACTIVE' } });
}

/** An EMR record in tenant A linked to the patient's Sabi account (via an ACTIVE enrollment). */
async function linkedRecord(account) {
  const plan = await prisma.hospitalMemberPlan.create({ data: { hospitalId: A.facilityId, name: 'Plan', description: 'Test', feeMinor: 0 } });
  await prisma.hospitalEnrollment.create({ data: { patientId: account.id, hospitalId: A.facilityId, planId: plan.id, status: 'ACTIVE' } });
  const created = await request(app).post(`${base(A)}/patients`).set('Authorization', A.auth).send(newPatient());
  const linked = await request(app).post(`${base(A)}/patients/${created.body.data.id}/link-account`).set('Authorization', A.auth).set('If-Match', 'W/"1"').send({ userId: account.id });
  expect(linked.status).toBe(200);
  return linked.body.data;
}

/** A confirmed appointment that has started, completed through the telemedicine service itself. */
async function completedAppointment(doctorUserId, patientUserId, { dependentId } = {}) {
  const profile = await prisma.professionalProfile.findUnique({ where: { userId: doctorUserId } });
  const startsAt = new Date(Date.now() - 30 * 60_000);
  const endsAt = new Date(Date.now() - 10 * 60_000);
  const slot = await prisma.doctorAvailabilitySlot.create({ data: { doctorProfileId: profile.id, startsAt, endsAt, consultationTypes: ['VIRTUAL'] } });
  const appointment = await prisma.doctorAppointment.create({
    data: { patientId: patientUserId, dependentId, doctorProfileId: profile.id, slotId: slot.id, startsAt, endsAt, consultationType: 'VIRTUAL', reason: 'Follow-up', status: 'CONFIRMED' },
  });
  await complete(doctorUserId, appointment.id);
  return appointment;
}

const handoffFor = (appointmentId) => prisma.emrTelehealthHandoff.findUnique({ where: { appointmentId } });
const designate = (who, tenant) => request(app).put(`${base(tenant)}/telehealth/designation`).set('Authorization', who.auth);

beforeAll(async () => {
  A = await createTenant('teleA');
  B = await createTenant('teleB');
  doctor = await addMember(A, ['DOCTOR']);
  doctorInB = { ...doctor, auth: tokenFor(doctor.userId, B.organizationId) };
  await prisma.organizationMembership.create({ data: { userId: doctor.userId, organizationId: B.organizationId, status: 'ACTIVE', joinedAt: new Date(), roles: { create: [{ roleCode: 'DOCTOR' }] } } });
  nurse = await addMember(A, ['NURSE']);
});

describe('telehealth designation', () => {
  it('only a doctor can designate; the other hospital learns only that one exists elsewhere', async () => {
    expect((await designate(nurse, A)).status).toBe(403);
    const set = await designate(doctor, A);
    expect(set.status).toBe(200);
    expect(set.body.data).toEqual({ designated: true, designatedElsewhere: false });
    const fromB = await request(app).get(`${base(B)}/telehealth/designation`).set('Authorization', doctorInB.auth);
    expect(fromB.body.data).toEqual({ designated: false, designatedElsewhere: true });
    expect(JSON.stringify(fromB.body)).not.toContain(A.organizationId);
  });
});

describe('UC-2: completed telemedicine visit → EMR encounter', () => {
  it('creates exactly one finished TELEHEALTH encounter for the linked patient, and replays create nothing new', async () => {
    await designate(doctor, A);
    const account = await patientAccount();
    const record = await linkedRecord(account);
    const appointment = await completedAppointment(doctor.userId, account.id);

    const event = await prisma.domainEvent.findFirst({ where: { type: 'doctor_appointment.completed', aggregateId: appointment.id } });
    expect(event).toBeTruthy();

    await processTelehealthHandoffs();
    const handoff = await handoffFor(appointment.id);
    expect(handoff).toMatchObject({ outcome: 'ENCOUNTER_CREATED', organizationId: A.organizationId });

    const encounters = await prisma.emrEncounter.findMany({ where: { sourceReference: appointment.id } });
    expect(encounters).toHaveLength(1);
    expect(encounters[0]).toMatchObject({
      id: handoff.encounterId, organizationId: A.organizationId, patientId: record.id, class: 'TELEHEALTH',
      status: 'FINISHED', source: 'TELEMEDICINE', attendingUserId: doctor.userId, reason: 'Follow-up',
    });
    expect(await prisma.emrAuditEvent.count({ where: { resourceId: handoff.encounterId, action: 'encounter.created' } })).toBe(1);
    const outbox = await prisma.emrOutboxEvent.findFirst({ where: { aggregateId: handoff.encounterId } });
    expect(outbox.payload.data).toMatchObject({ source: 'TELEMEDICINE' });

    // Replay: the worker runs again, and even with the outcome row lost, no second encounter.
    await processTelehealthHandoffs();
    await prisma.emrTelehealthHandoff.delete({ where: { appointmentId: appointment.id } });
    await processTelehealthHandoffs();
    expect(await prisma.emrEncounter.count({ where: { sourceReference: appointment.id } })).toBe(1);
    expect((await handoffFor(appointment.id)).encounterId).toBe(handoff.encounterId);

    // The visit is visible to the hospital's clinicians like any other.
    const seen = await request(app).get(`${base(A)}/encounters/${handoff.encounterId}`).set('Authorization', doctor.auth);
    expect(seen.status).toBe(200);
    expect(seen.body.data.patient.id).toBe(record.id);
  });

  it('never guesses: no linked record, a dependent, or no designation each produce no encounter and a recorded reason', async () => {
    await designate(doctor, A);
    const stranger = await patientAccount(); // not linked to any EMR record
    const unlinked = await completedAppointment(doctor.userId, stranger.id);

    const parent = await patientAccount();
    await linkedRecord(parent);
    const child = await prisma.dependentProfile.create({ data: { patientId: parent.id, fullName: 'Test Child' } });
    const forChild = await completedAppointment(doctor.userId, parent.id, { dependentId: child.id });

    const loneDoctor = await addMember(await createTenant('teleC'), ['DOCTOR']); // never designated
    const undesignated = await completedAppointment(loneDoctor.userId, stranger.id);

    await processTelehealthHandoffs();
    expect((await handoffFor(unlinked.id)).outcome).toBe('SKIPPED_NO_LINKED_PATIENT');
    expect((await handoffFor(forChild.id)).outcome).toBe('SKIPPED_DEPENDENT');
    expect((await handoffFor(undesignated.id)).outcome).toBe('SKIPPED_NO_DESIGNATED_ORGANIZATION');
    expect(await prisma.emrEncounter.count({ where: { sourceReference: { in: [unlinked.id, forChild.id, undesignated.id] } } })).toBe(0);
  });

  it('a doctor who left the designated hospital sends nothing there', async () => {
    const leaving = await addMember(A, ['DOCTOR']);
    await designate(leaving, A);
    const account = await patientAccount();
    await linkedRecord(account);
    await prisma.organizationMembership.update({ where: { userId_organizationId: { userId: leaving.userId, organizationId: A.organizationId } }, data: { status: 'REVOKED' } });
    const appointment = await completedAppointment(leaving.userId, account.id);
    await processTelehealthHandoffs();
    expect((await handoffFor(appointment.id)).outcome).toBe('SKIPPED_NOT_A_MEMBER');
    expect(await prisma.emrEncounter.count({ where: { sourceReference: appointment.id } })).toBe(0);
  });
});
