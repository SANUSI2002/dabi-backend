// UC-2: a completed telemedicine appointment becomes exactly one EMR encounter in the doctor's
// designated organization — or a recorded reason why not. Never guessed:
//   - the organization is the one the doctor explicitly designated (and is still a doctor at),
//   - the patient is matched only through a linked Sabi account (never by name or birth date),
//   - dependents are skipped until dependents can be linked to EMR records.
//
// Consumes `doctor_appointment.completed` domain events written by the telemedicine module in
// the same transaction as the completion. Safe to run on several workers at once: the handoff
// row is keyed by appointment, and (organization, source, source_reference) is unique on
// encounters, so a replay or a race never creates a second encounter.
import prisma from '../../../config/db.js';
import { approvedEmrFor } from '../emr.entitlement.js';
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { enqueueEvent } from '../core/outbox.js';
import { logger } from '../core/logging.js';

async function record(event, outcome, { organizationId = null, encounterId = null } = {}) {
  await prisma.emrTelehealthHandoff.createMany({
    data: [{ appointmentId: event.appointmentId, eventId: event.id, outcome, organizationId, encounterId }],
    skipDuplicates: true,
  });
  logger.info('emr.telehealth_handoff', { appointmentId: event.appointmentId, outcome, organizationId, encounterId });
  return outcome;
}

async function createEncounter(context, appointment) {
  return withTenant(context, async (tx) => {
    const patient = await tx.emrPatient.findFirst({
      where: { organizationId: context.organizationId, linkedUserId: appointment.patientId },
      select: { id: true, status: true },
    });
    if (!patient) return { outcome: 'SKIPPED_NO_LINKED_PATIENT' };
    if (patient.status !== 'ACTIVE') return { outcome: 'SKIPPED_PATIENT_INACTIVE' };
    const existing = await tx.emrEncounter.findFirst({
      where: { organizationId: context.organizationId, source: 'TELEMEDICINE', sourceReference: appointment.id },
      select: { id: true },
    });
    if (existing) return { outcome: 'ENCOUNTER_CREATED', encounterId: existing.id };
    const encounter = await tx.emrEncounter.create({
      data: {
        organizationId: context.organizationId, patientId: patient.id, class: 'TELEHEALTH', status: 'FINISHED',
        source: 'TELEMEDICINE', sourceReference: appointment.id, reason: appointment.reason,
        attendingUserId: context.userId, createdByUserId: context.userId,
        arrivedAt: appointment.startsAt, startedAt: appointment.startsAt, endedAt: appointment.completedAt ?? appointment.endsAt,
      },
      select: { id: true },
    });
    await recordAudit(tx, context, { action: 'encounter.created', resourceType: 'encounter', resourceId: encounter.id });
    await enqueueEvent(tx, context, { type: 'encounter.created', aggregateType: 'encounter', aggregateId: encounter.id, data: { patientId: patient.id, class: 'TELEHEALTH', source: 'TELEMEDICINE' } });
    return { outcome: 'ENCOUNTER_CREATED', encounterId: encounter.id };
  });
}

export async function handOff(event) {
  const appointment = await prisma.doctorAppointment.findUnique({
    where: { id: event.appointmentId },
    select: {
      id: true, status: true, patientId: true, dependentId: true, reason: true, startsAt: true, endsAt: true, completedAt: true,
      doctorProfile: { select: { userId: true, emrOrganizationId: true } },
    },
  });
  if (!appointment || appointment.status !== 'COMPLETED') return record(event, 'SKIPPED_NOT_COMPLETED');
  if (appointment.dependentId) return record(event, 'SKIPPED_DEPENDENT');
  const organizationId = appointment.doctorProfile.emrOrganizationId;
  if (!organizationId) return record(event, 'SKIPPED_NO_DESIGNATED_ORGANIZATION');

  const doctorUserId = appointment.doctorProfile.userId;
  const membership = await prisma.organizationMembership.findFirst({
    where: { userId: doctorUserId, organizationId, status: 'ACTIVE', roles: { some: { roleCode: 'DOCTOR' } } },
    select: { id: true },
  });
  if (!membership) return record(event, 'SKIPPED_NOT_A_MEMBER', { organizationId });
  const organization = await prisma.identityOrganization.findUnique({ where: { id: organizationId }, select: { type: true, organisationId: true, pharmacyId: true } });
  const entitled = organization && await approvedEmrFor({ organization: { id: organizationId, type: organization.type, facilityId: organization.organisationId ?? organization.pharmacyId } });
  if (!entitled) return record(event, 'SKIPPED_NO_EMR_ENTITLEMENT', { organizationId });

  const context = { organizationId, userId: doctorUserId, requestId: `handoff:${event.id}` };
  let result;
  try {
    result = await createEncounter(context, appointment);
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    result = await createEncounter(context, appointment); // lost a race: the other worker's encounter is found
  }
  return record(event, result.outcome, { organizationId, encounterId: result.encounterId ?? null });
}

/** One pass: every completion event without a recorded outcome. Failures are retried next pass. */
export async function processTelehealthHandoffs({ limit = 50 } = {}) {
  const events = await prisma.$queryRaw`
    SELECT e."id", e."aggregate_id" AS "appointmentId"
    FROM "domain_events" e
    WHERE e."type" = 'doctor_appointment.completed'
      AND NOT EXISTS (SELECT 1 FROM "emr_telehealth_handoffs" h WHERE h."appointment_id" = e."aggregate_id")
    ORDER BY e."created_at"
    LIMIT ${limit}`;
  const outcomes = [];
  for (const event of events) {
    try {
      outcomes.push(await handOff(event));
    } catch (error) {
      logger.error('emr.telehealth_handoff_failed', { appointmentId: event.appointmentId, name: error?.name, code: error?.code });
    }
  }
  return outcomes;
}
