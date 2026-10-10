// Appointment requests patients make in the Sabi app, worked from the hospital's EMR desk so the
// front desk has one list.
//
// A request (hospital_appointments) belongs to the patient app: a Sabi user, enrolled with the
// hospital, asks for a visit at a time. The EMR reaches its own hospital's requests only through
// the tenant-scoped emr_appointment_requests view. Confirming books an EMR appointment for the
// requested time and marks the request SCHEDULED in one transaction; rejecting records the
// hospital's reason. A request is decided once: the decision is a conditional update on PENDING.
//
// Which EMR record a request is for:
//   - the account holder's own visit: the record linked to their Sabi account. With none linked
//     yet, the desk chooses the record (after finding or registering the patient) and confirming
//     links it — the request came with an active enrollment, the patient's consent to be known here.
//   - a dependent's visit: dependents cannot be linked to EMR records yet, so the desk chooses the
//     record each time and nothing is linked.
import prisma from '../../../config/db.js';
import { withTenant } from '../core/db.js';
import { decodeCursor, page } from '../core/cursor.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { BOOKING_CONFLICTS, checkProvider, insertBooking, named } from './appointments.service.js';
import * as repo from './appointment-requests.repository.js';

const PAST_GRACE_MS = 5 * 60_000;
const patientSummary = { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true, phone: true, linkedUserId: true };
const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null);
const summary = ({ id, medicalRecordNumber, givenName, familyName, dateOfBirth, sex, phone }) => ({ id, medicalRecordNumber, givenName, familyName, dateOfBirth: dateOnly(dateOfBirth), sex, phone });
const statusWord = (status) => status.toLowerCase().replace('_', '-');

/** The EMR appointment type closest to what the patient picked in the app ("Follow-up", "Consultation"…). */
export function suggestedType(appointmentType) {
  const text = (appointmentType ?? '').toLowerCase();
  if (/follow/.test(text)) return 'FOLLOW_UP';
  if (/antenatal|prenatal|pregnan|\banc\b/.test(text)) return 'ANC';
  if (/postnatal|\bpnc\b/.test(text)) return 'PNC';
  if (/immuni|vaccin/.test(text)) return 'IMMUNIZATION';
  if (/specialist/.test(text)) return 'SPECIALIST';
  return 'GENERAL';
}

/** The booking's reason: what the patient picked and what they wrote. */
const bookingReason = ({ appointmentType, reason }) => [appointmentType, reason].filter(Boolean).join(' — ').slice(0, 300) || null;

/**
 * Who asked, for the desk to find the patient's record: the account holder's name and contact
 * details and, for a dependent, the dependent's. These live outside the EMR tables, so they are
 * read after the tenant transaction, for the requests it returned only.
 */
async function withRequesters(items) {
  const userIds = [...new Set(items.map((item) => item.userId))];
  const dependentIds = [...new Set(items.map((item) => item.dependentId).filter(Boolean))];
  const [users, dependents] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, full_name: true, phone_number: true, email: true, dob: true } }) : [],
    dependentIds.length ? prisma.dependentProfile.findMany({ where: { id: { in: dependentIds } }, select: { id: true, fullName: true, dateOfBirth: true, gender: true } }) : [],
  ]);
  const userById = new Map(users.map((user) => [user.id, user]));
  const dependentById = new Map(dependents.map((dependent) => [dependent.id, dependent]));
  return items.map(({ userId, dependentId, ...item }) => {
    const user = userById.get(userId);
    const dependent = dependentId ? dependentById.get(dependentId) : null;
    return {
      ...item,
      requester: { userId, name: user?.full_name ?? null, phone: user?.phone_number ?? null, email: user?.email ?? null, dateOfBirth: dateOnly(user?.dob) },
      dependent: dependent ? { id: dependent.id, fullName: dependent.fullName, dateOfBirth: dateOnly(dependent.dateOfBirth), gender: dependent.gender ?? null } : null,
    };
  });
}

/** Requests made to this hospital (default: those waiting for a decision), the soonest asked-for time first. */
export async function listRequests(context, { status, cursor, limit }) {
  const after = cursor ? decodeCursor(cursor) : null;
  const result = await withTenant(context, async (tx) => {
    const rows = await repo.listRequests(tx, { statuses: status ?? ['PENDING'], after, take: limit + 1 });
    const { items, nextCursor } = page(rows, limit, 'requestedAt');
    const ids = items.map((item) => item.id);
    const holders = [...new Set(items.filter((item) => !item.dependentId).map((item) => item.userId))];
    const [linked, bookings, names] = await Promise.all([
      holders.length ? tx.emrPatient.findMany({ where: { organizationId: context.organizationId, linkedUserId: { in: holders } }, select: patientSummary }) : [],
      ids.length ? tx.emrAppointment.findMany({ where: { organizationId: context.organizationId, requestId: { in: ids } }, select: { id: true, requestId: true } }) : [],
      userNameMap(tx, items.map((item) => item.decidedByUserId)),
    ]);
    await recordAudit(tx, context, { action: 'appointment_request.listed', resourceType: 'appointment_request' });
    const patientByUser = new Map(linked.map((patient) => [patient.linkedUserId, summary(patient)]));
    const bookingByRequest = new Map(bookings.map((booking) => [booking.requestId, booking.id]));
    return {
      nextCursor,
      items: items.map(({ decidedByUserId, ...item }) => ({
        ...item,
        suggestedType: suggestedType(item.appointmentType),
        decidedByName: decidedByUserId ? names.get(decidedByUserId) ?? null : null,
        // Only the account holder's own visits can use the linked record.
        linkedPatient: item.dependentId ? null : patientByUser.get(item.userId) ?? null,
        appointmentId: bookingByRequest.get(item.id) ?? null,
      })),
    };
  });
  return { ...result, items: await withRequesters(result.items) };
}

/** Why a request cannot be decided: another tenant's (or no) request is NOT_FOUND; a decided one is INVALID_STATE. */
async function undecidable(tx, id) {
  const current = await repo.findRequest(tx, id);
  if (!current) return new EmrError('APPOINTMENT_REQUEST_NOT_FOUND');
  return new EmrError('INVALID_STATE', { message: `This request is already ${statusWord(current.status)}.` });
}

/**
 * Whether confirming may link the chosen record to the requester's account, decided before the
 * tenant transaction because enrollments and memberships are not EMR tables. Returns null when it
 * may, else the error to raise if a link turns out to be needed.
 */
async function linkBlocker(context, requestId) {
  const asked = context.facilityId
    ? await prisma.hospitalAppointment.findFirst({ where: { id: requestId, hospitalId: context.facilityId }, select: { patientId: true, dependentId: true } })
    : null;
  if (!asked || asked.dependentId) return null; // not found is reported inside the transaction; dependents are never linked
  if (!context.permissions.includes('patient.update')) {
    return new EmrError('PERMISSION_DENIED', { message: 'This patient’s record is not linked to their Sabi account yet; someone who can update patient records must confirm it.' });
  }
  const enrollment = await prisma.hospitalEnrollment.findFirst({
    where: { patientId: asked.patientId, hospitalId: context.facilityId, dependentId: null, status: 'ACTIVE' },
    select: { id: true },
  });
  return enrollment ? null : new EmrError('INVALID_STATE', { message: 'The patient has no active enrollment with this hospital, so their record cannot be linked. Reject the request instead.' });
}

/** The EMR record the request is for (see the header), linking it to the requester's account when needed. */
async function patientFor(tx, context, request, chosenId, blocker) {
  const linked = request.dependentId ? null : await tx.emrPatient.findFirst({
    where: { organizationId: context.organizationId, linkedUserId: request.userId }, select: { id: true, medicalRecordNumber: true },
  });
  if (linked) {
    if (chosenId && chosenId !== linked.id) {
      throw new EmrError('PATIENT_ALREADY_LINKED', { message: `This patient’s Sabi account is linked to record ${linked.medicalRecordNumber}; confirm with that record.` });
    }
    return linked.id;
  }
  if (!chosenId) throw new EmrError('PATIENT_MATCH_REQUIRED');
  const chosen = await tx.emrPatient.findFirst({ where: { organizationId: context.organizationId, id: chosenId }, select: { id: true, status: true, linkedUserId: true } });
  if (!chosen) throw new EmrError('PATIENT_NOT_FOUND');
  if (chosen.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
  // A linked record is an account holder's own, never a dependent's.
  if (request.dependentId && chosen.linkedUserId) {
    throw new EmrError('PATIENT_ALREADY_LINKED', { message: 'This record belongs to a Sabi account holder; choose the dependent’s own record.' });
  }
  if (request.dependentId) return chosen.id;
  if (chosen.linkedUserId) throw new EmrError('PATIENT_ALREADY_LINKED', { message: 'This record is already linked to a different account.' });
  if (blocker) throw blocker;
  const { count } = await tx.emrPatient.updateMany({
    where: { organizationId: context.organizationId, id: chosen.id, linkedUserId: null },
    data: { linkedUserId: request.userId, updatedByUserId: context.userId, version: { increment: 1 } },
  });
  if (count !== 1) throw new EmrError('PATIENT_ALREADY_LINKED', { message: 'This record is already linked to a different account.' });
  await recordAudit(tx, context, { action: 'patient.account_linked', resourceType: 'patient', resourceId: chosen.id, changedFields: ['linkedUserId'] });
  await enqueueEvent(tx, context, { type: 'patient.account_linked', aggregateType: 'patient', aggregateId: chosen.id, data: { changedFields: ['linkedUserId'] } });
  return chosen.id;
}

/** Confirms a request: books the patient in for the requested time and marks the request SCHEDULED. */
export async function confirmRequest(context, requestId, input, { idempotencyKey } = {}) {
  await checkProvider(context, input.providerUserId);
  const blocker = await linkBlocker(context, requestId);
  try {
    return await withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'appointment_request.confirm', body: { requestId, ...input } }, async () => {
      const request = await repo.decide(tx, context, requestId, 'SCHEDULED');
      if (!request) throw await undecidable(tx, requestId);
      if (request.requestedAt.getTime() < Date.now() - PAST_GRACE_MS) {
        throw new EmrError('INVALID_STATE', { message: 'The time the patient asked for has passed. Reject the request so they can ask for another time.' });
      }
      const patientId = await patientFor(tx, context, request, input.patientId, blocker);
      const booking = await insertBooking(tx, context, {
        patientId, scheduledAt: request.requestedAt, type: input.type ?? suggestedType(request.appointmentType),
        providerUserId: input.providerUserId, reason: bookingReason(request), requestId,
      });
      await recordAudit(tx, context, { action: 'appointment_request.confirmed', resourceType: 'appointment_request', resourceId: requestId });
      return {
        statusCode: 200,
        body: { request: { id: requestId, status: request.status, decidedAt: request.decidedAt, appointmentId: booking.id }, appointment: await named(tx, context, booking.id) },
      };
    }));
  } catch (error) {
    throw uniqueViolation(error, { ...BOOKING_CONFLICTS, linked_user_id: 'PATIENT_ALREADY_LINKED' }) ?? error;
  }
}

/** Declines a request with the hospital's reason, which the patient sees in the app. */
export async function rejectRequest(context, requestId, { reason }) {
  return withTenant(context, async (tx) => {
    const request = await repo.decide(tx, context, requestId, 'REJECTED', reason);
    if (!request) throw await undecidable(tx, requestId);
    await recordAudit(tx, context, { action: 'appointment_request.rejected', resourceType: 'appointment_request', resourceId: requestId });
    await enqueueEvent(tx, context, { type: 'appointment_request.rejected', aggregateType: 'appointment_request', aggregateId: requestId });
    return { id: requestId, status: request.status, decisionReason: request.decisionReason, decidedAt: request.decidedAt };
  });
}
