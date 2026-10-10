// Hospital appointments: book → check in (opens the visit and queues the patient) | no-show | cancel.
//
// Check-in reuses an open visit when the patient already has one (they may have walked in first)
// instead of opening a second; otherwise it opens an outpatient visit and places the patient in
// the station queue the appointment type belongs to. Every change is audited and emits an event.
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { activeMemberWithPermission, activeMemberWithRole } from '../core/membership.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';
import { OPEN_STATUSES } from '../encounters/encounters.policy.js';
import { createForEncounter } from '../queue/queue.service.js';

const HOUR = 3_600_000;
/** The queue a checked-in patient joins, by appointment type. */
export const STATION_FOR_TYPE = { GENERAL: 'Vital', ANC: 'ANC', PNC: 'Vital', FOLLOW_UP: 'Vital', IMMUNIZATION: 'Immunization', SPECIALIST: 'Vital' };
const TYPE_LABEL = { GENERAL: 'General', ANC: 'Antenatal', PNC: 'Postnatal', FOLLOW_UP: 'Follow-up', IMMUNIZATION: 'Immunization', SPECIALIST: 'Specialist' };
const PEOPLE = ['providerUserId', 'bookedByUserId', 'checkedInByUserId', 'noShowByUserId', 'cancelledByUserId'];
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true, phone: true } };
const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

async function withNames(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((row) => PEOPLE.map((field) => row[field])));
  return rows.map((row) => ({
    ...row,
    ...Object.fromEntries(PEOPLE.map((field) => [field.replace(/UserId$/, 'Name'), row[field] ? names.get(row[field]) ?? null : null])),
    ...(row.patient ? { patient: { ...row.patient, dateOfBirth: dateOnly(row.patient.dateOfBirth) } } : {}),
  }));
}

async function loadScheduled(tx, context, id) {
  const row = await tx.emrAppointment.findFirst({ where: { organizationId: context.organizationId, id } });
  if (!row) throw new EmrError('APPOINTMENT_NOT_FOUND');
  if (row.status !== 'SCHEDULED') throw new EmrError('INVALID_STATE', { message: `This appointment is already ${row.status.toLowerCase().replace('_', '-')}.` });
  return row;
}

const named = async (tx, context, id) => (await withNames(tx, [await tx.emrAppointment.findFirst({ where: { organizationId: context.organizationId, id }, include: { patient: patientSummary } })]))[0];

/** Appointments in a time window (default: from now), soonest first, with patient and staff names. */
export async function listAppointments(context, { from, to, status, patientId, providerUserId, cursor, limit }) {
  const after = afterCursor('scheduledAt', cursor, 'asc');
  return withTenant(context, async (tx) => {
    const rows = await tx.emrAppointment.findMany({
      where: {
        organizationId: context.organizationId,
        scheduledAt: { gte: from ? new Date(from) : new Date(), ...(to ? { lt: new Date(to) } : {}) },
        ...(status ? { status: { in: status } } : {}),
        ...(patientId ? { patientId } : {}),
        ...(providerUserId ? { providerUserId } : {}),
        ...after,
      },
      include: { patient: patientSummary },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'appointment.listed', resourceType: 'appointment' });
    const result = page(rows, limit, 'scheduledAt');
    return { ...result, items: await withNames(tx, result.items) };
  });
}

export async function bookAppointment(context, input, { idempotencyKey } = {}) {
  if (new Date(input.scheduledAt).getTime() < Date.now() - 5 * 60_000) {
    throw new EmrError('VALIDATION_FAILED', { message: 'An appointment cannot be booked in the past.' });
  }
  if (input.providerUserId && !(await activeMemberWithPermission(context.organizationId, input.providerUserId, 'vitals.record'))) {
    throw new EmrError('VALIDATION_FAILED', { message: 'The provider must be an active clinician in this organization.' });
  }
  try {
    return await withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'appointment.book', body: input }, async () => {
      const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true });
      if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
      if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
      const row = await tx.emrAppointment.create({
        data: {
          organizationId: context.organizationId, patientId: patient.id, scheduledAt: new Date(input.scheduledAt), type: input.type,
          providerUserId: input.providerUserId ?? null, reason: input.reason ?? null, bookedByUserId: context.userId,
        },
      });
      await recordAudit(tx, context, { action: 'appointment.booked', resourceType: 'appointment', resourceId: row.id });
      await enqueueEvent(tx, context, { type: 'appointment.booked', aggregateType: 'patient', aggregateId: patient.id, data: { appointmentId: row.id } });
      return { statusCode: 201, body: await named(tx, context, row.id) };
    }));
  } catch (error) {
    throw uniqueViolation(error, { emr_appointments_patient_slot_key: 'APPOINTMENT_CONFLICT' }) ?? error;
  }
}

/** The patient has arrived: open (or reuse) their visit, queue them, and mark the appointment attended. */
export async function checkIn(context, id, expectedVersion) {
  // Only a doctor can be a visit's attending clinician; a nurse-led appointment leaves it open.
  // Memberships are identity tables, so this is checked before the tenant transaction opens (the
  // provider of a booking never changes afterwards).
  const booked = await withTenant(context, (tx) => tx.emrAppointment.findFirst({ where: { organizationId: context.organizationId, id }, select: { providerUserId: true } }));
  const doctorProvider = booked?.providerUserId && (await activeMemberWithRole(context.organizationId, booked.providerUserId, 'DOCTOR')) ? booked.providerUserId : null;
  return withTenant(context, async (tx) => {
    const appointment = await loadScheduled(tx, context, id);
    if (appointment.scheduledAt.getTime() - Date.now() > 24 * HOUR) {
      throw new EmrError('INVALID_STATE', { message: 'This appointment is for a later day; book the patient in as a walk-in instead.' });
    }
    const patient = await findPatient(tx, context.organizationId, appointment.patientId, { id: true, status: true });
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');

    let encounter = await tx.emrEncounter.findFirst({
      where: { organizationId: context.organizationId, patientId: appointment.patientId, status: { in: OPEN_STATUSES } },
      select: { id: true, patientId: true },
    });
    if (!encounter) {
      const attending = appointment.providerUserId === doctorProvider ? doctorProvider : null;
      const reason = appointment.reason ?? `${TYPE_LABEL[appointment.type]} appointment`;
      encounter = await tx.emrEncounter.create({
        data: {
          organizationId: context.organizationId, patientId: appointment.patientId, class: 'OUTPATIENT', reason, attendingUserId: attending,
          source: 'APPOINTMENT', sourceReference: appointment.id, createdByUserId: context.userId,
        },
        select: { id: true, patientId: true },
      });
      await createForEncounter(tx, context, encounter, { station: STATION_FOR_TYPE[appointment.type], priority: 'NORMAL', complaint: reason });
      await recordAudit(tx, context, { action: 'encounter.created', resourceType: 'encounter', resourceId: encounter.id });
      await enqueueEvent(tx, context, { type: 'encounter.created', aggregateType: 'encounter', aggregateId: encounter.id, data: { patientId: encounter.patientId, class: 'OUTPATIENT' } });
    }
    await updateVersioned(tx.emrAppointment, {
      organizationId: context.organizationId, id, expectedVersion, notFoundCode: 'APPOINTMENT_NOT_FOUND',
      data: { status: 'ATTENDED', encounterId: encounter.id, checkedInAt: new Date(), checkedInByUserId: context.userId },
    });
    await recordAudit(tx, context, { action: 'appointment.checked_in', resourceType: 'appointment', resourceId: id });
    await enqueueEvent(tx, context, { type: 'appointment.checked_in', aggregateType: 'patient', aggregateId: appointment.patientId, data: { appointmentId: id, encounterId: encounter.id } });
    return named(tx, context, id);
  });
}

/** The patient did not come. Only once the appointment time has passed. */
export async function markNoShow(context, id, expectedVersion) {
  return withTenant(context, async (tx) => {
    const appointment = await loadScheduled(tx, context, id);
    if (appointment.scheduledAt.getTime() > Date.now()) throw new EmrError('INVALID_STATE', { message: 'The appointment time has not come yet.' });
    await updateVersioned(tx.emrAppointment, {
      organizationId: context.organizationId, id, expectedVersion, notFoundCode: 'APPOINTMENT_NOT_FOUND',
      data: { status: 'NO_SHOW', noShowAt: new Date(), noShowByUserId: context.userId },
    });
    await recordAudit(tx, context, { action: 'appointment.no_show', resourceType: 'appointment', resourceId: id });
    await enqueueEvent(tx, context, { type: 'appointment.no_show', aggregateType: 'patient', aggregateId: appointment.patientId, data: { appointmentId: id } });
    return named(tx, context, id);
  });
}

export async function cancelAppointment(context, id, expectedVersion, { reason }) {
  return withTenant(context, async (tx) => {
    const appointment = await loadScheduled(tx, context, id);
    await updateVersioned(tx.emrAppointment, {
      organizationId: context.organizationId, id, expectedVersion, notFoundCode: 'APPOINTMENT_NOT_FOUND',
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByUserId: context.userId, cancellationReason: reason },
    });
    await recordAudit(tx, context, { action: 'appointment.cancelled', resourceType: 'appointment', resourceId: id });
    await enqueueEvent(tx, context, { type: 'appointment.cancelled', aggregateType: 'patient', aggregateId: appointment.patientId, data: { appointmentId: id } });
    return named(tx, context, id);
  });
}
