// Patient-app appointment requests (hospital_appointments) as the EMR sees them: only through the
// emr_appointment_requests view, which the database limits to the current tenant's hospital
// (migration 20261019120000_emr_appointment_requests). Always called with the tenant transaction.
import { Prisma } from '@prisma/client';

const COLUMNS = Prisma.sql`"id", "user_id" AS "userId", "dependent_id" AS "dependentId", "status"::text AS "status",
  "requested_at" AS "requestedAt", "appointment_type" AS "appointmentType", "reason", "decision_reason" AS "decisionReason",
  "decided_at" AS "decidedAt", "decided_by_user_id" AS "decidedByUserId", "checked_in_at" AS "checkedInAt", "created_at" AS "createdAt"`;
const STATUS = Prisma.sql`"HospitalAppointmentStatus"`;
// Request timestamps are stored as UTC wall-clock values (timestamp without time zone).
const utc = (date) => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** Requests in the given statuses, oldest requested time first, after the (requestedAt, id) cursor. */
export const listRequests = (tx, { statuses, after, take }) => tx.$queryRaw`
  SELECT ${COLUMNS} FROM "emr_appointment_requests"
  WHERE "status"::text = ANY(${statuses}::text[])
  ${after ? Prisma.sql`AND ("requested_at", "id") > (${utc(after.at)}, ${after.id})` : Prisma.empty}
  ORDER BY "requested_at", "id"
  LIMIT ${take}`;

export const findRequest = async (tx, id) => (await tx.$queryRaw`SELECT ${COLUMNS} FROM "emr_appointment_requests" WHERE "id" = ${id}`)[0] ?? null;

/**
 * Decides a PENDING request (SCHEDULED or REJECTED). The conditional update is the lock and the
 * check in one: of two desks deciding at once, the second finds nothing left to decide. Returns
 * the decided request, or null when it is not (or no longer) pending.
 */
export const decide = async (tx, context, id, status, reason = null) => (await tx.$queryRaw`
  UPDATE "emr_appointment_requests"
  SET "status" = ${status}::${STATUS}, "decision_reason" = ${reason}, "decided_at" = now(), "decided_by_user_id" = ${context.userId}, "updated_at" = now()
  WHERE "id" = ${id} AND "status" = 'PENDING'
  RETURNING ${COLUMNS}`)[0] ?? null;

/** The desk checked the patient in: the request shows it too (unless the patient already checked in from the app). */
export const markCheckedIn = (tx, id) => tx.$executeRaw`
  UPDATE "emr_appointment_requests" SET "status" = 'CHECKED_IN'::${STATUS}, "checked_in_at" = now(), "updated_at" = now()
  WHERE "id" = ${id} AND "status" = 'SCHEDULED'`;

/** The desk cancelled the booking: the patient sees the request cancelled, with the hospital's reason. */
export const markCancelled = (tx, id, reason) => tx.$executeRaw`
  UPDATE "emr_appointment_requests" SET "status" = 'CANCELLED'::${STATUS}, "decision_reason" = ${reason}, "updated_at" = now()
  WHERE "id" = ${id} AND "status" = 'SCHEDULED'`;
