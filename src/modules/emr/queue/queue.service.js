// Station queue: patient flow through the hospital (Vitals → Consultation → Lab → Pharmacy → Exit).
//
// One queue entry per visit, created at check-in and closed when the visit finishes. Every change
// is recorded in the append-only emr_queue_events. "Call next" picks the most urgent, longest-
// waiting patient at a station with FOR UPDATE SKIP LOCKED, so two staff pressing it at the same
// moment always get two different patients (or one gets "nobody waiting") — never the same one.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError } from '../core/errors.js';
import { withUserNames } from '../core/people.js';
import { OPEN_STATUSES } from '../encounters/encounters.policy.js';

const ACTIVE_STATUSES = ['WAITING', 'IN_PROGRESS'];
const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

const entrySelect = {
  id: true, encounterId: true, patientId: true, station: true, priority: true, status: true, complaint: true,
  queuedAt: true, calledAt: true, assignedToUserId: true, version: true,
  patient: { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, preferredName: true, dateOfBirth: true, sex: true, payer: true } },
  encounter: { select: { id: true, status: true, class: true, arrivedAt: true } },
};

export function toEntry(row, now = Date.now()) {
  return {
    ...row,
    waitMinutes: Math.max(0, Math.floor((now - row.queuedAt.getTime()) / 60_000)),
    ...(row.patient ? { patient: { ...row.patient, dateOfBirth: dateOnly(row.patient.dateOfBirth) } } : {}),
  };
}

const event = (tx, context, entry, action) => tx.emrQueueEvent.create({
  data: { organizationId: context.organizationId, queueEntryId: entry.id, action, station: entry.station, status: entry.status, priority: entry.priority, userId: context.userId },
});

/** Called by check-in, inside its transaction. */
export async function createForEncounter(tx, context, encounter, { station, priority, complaint }) {
  const entry = await tx.emrQueueEntry.create({
    data: { organizationId: context.organizationId, encounterId: encounter.id, patientId: encounter.patientId, station, priority, complaint: complaint ?? null },
    select: entrySelect,
  });
  await event(tx, context, entry, 'CHECKED_IN');
  return entry;
}

/** Called when a visit finishes, is cancelled or its patient is discharged: leaves the queue. */
export async function closeForEncounter(tx, context, encounterId) {
  const entry = await tx.emrQueueEntry.findFirst({ where: { organizationId: context.organizationId, encounterId, status: { in: ACTIVE_STATUSES } } });
  if (!entry) return;
  await tx.emrQueueEntry.updateMany({ where: { organizationId: context.organizationId, id: entry.id }, data: { status: 'COMPLETED', version: { increment: 1 } } });
  await event(tx, context, { ...entry, status: 'COMPLETED' }, 'CLOSED');
}

export async function listQueue(context, { station, status, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrQueueEntry.findMany({
      where: {
        organizationId: context.organizationId,
        status: { in: status ?? ACTIVE_STATUSES },
        ...(station ? { station } : {}),
        encounter: { status: { in: OPEN_STATUSES } },
      },
      select: entrySelect,
      orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    await recordAudit(tx, context, { action: 'queue.viewed', resourceType: 'queue' });
    const now = Date.now();
    return (await withUserNames(tx, rows, 'assignedToUserId', 'assignedToName')).map((row) => toEntry(row, now));
  });
}

/** Most urgent, longest-waiting patient — at one station, or across every station when none is given. */
export async function callNext(context, { station = null }) {
  return withTenant(context, async (tx) => {
    const [next] = await tx.$queryRaw`
      SELECT q."id" FROM "emr_queue_entries" q
      JOIN "emr_encounters" e ON e."organization_id" = q."organization_id" AND e."id" = q."encounter_id"
      WHERE q."organization_id" = ${context.organizationId} AND (${station}::text IS NULL OR q."station" = ${station}) AND q."status" = 'WAITING'
        AND e."status" IN ('ARRIVED', 'IN_PROGRESS')
      ORDER BY q."priority", q."queued_at", q."id"
      LIMIT 1
      FOR UPDATE OF q SKIP LOCKED`;
    if (!next) throw new EmrError('NOTHING_WAITING');
    await tx.emrQueueEntry.updateMany({
      where: { organizationId: context.organizationId, id: next.id, status: 'WAITING' },
      data: { status: 'IN_PROGRESS', calledAt: new Date(), assignedToUserId: context.userId, version: { increment: 1 } },
    });
    const entry = await tx.emrQueueEntry.findFirst({ where: { organizationId: context.organizationId, id: next.id }, select: entrySelect });
    await event(tx, context, entry, 'CALLED');
    await recordAudit(tx, context, { action: 'queue.called', resourceType: 'queue_entry', resourceId: entry.id });
    return toEntry((await withUserNames(tx, [entry], 'assignedToUserId', 'assignedToName'))[0]);
  });
}

/**
 * Moves a patient to another station (back to WAITING there), changes status, and/or priority.
 * Taking a patient IN_PROGRESS assigns them to the caller.
 */
export async function updateEntry(context, entryId, expectedVersion, { station, status, priority }) {
  return withTenant(context, async (tx) => {
    const current = await tx.emrQueueEntry.findFirst({ where: { organizationId: context.organizationId, id: entryId }, select: entrySelect });
    if (!current) throw new EmrError('QUEUE_ENTRY_NOT_FOUND');
    if (!OPEN_STATUSES.includes(current.encounter.status)) throw new EmrError('INVALID_STATE', { message: 'This visit is closed; it is no longer in the queue.' });
    const moving = station !== undefined && station !== current.station;
    const nextStatus = status ?? (moving ? 'WAITING' : current.status);
    const data = {
      ...(moving ? { station, queuedAt: new Date() } : {}),
      ...(priority !== undefined ? { priority } : {}),
      status: nextStatus,
      ...(nextStatus === 'IN_PROGRESS' && (moving || current.status !== 'IN_PROGRESS') ? { calledAt: new Date(), assignedToUserId: context.userId } : {}),
      ...(nextStatus === 'WAITING' ? { calledAt: null, assignedToUserId: null } : {}),
    };
    const updated = await updateVersioned(tx.emrQueueEntry, { organizationId: context.organizationId, id: entryId, expectedVersion, data, select: entrySelect, notFoundCode: 'QUEUE_ENTRY_NOT_FOUND' });
    const action = moving ? 'MOVED' : nextStatus === 'IN_PROGRESS' && current.status !== 'IN_PROGRESS' ? 'CALLED'
      : nextStatus !== current.status ? 'STATUS_CHANGED' : 'PRIORITY_CHANGED';
    await event(tx, context, updated, action);
    await recordAudit(tx, context, { action: `queue.${action.toLowerCase()}`, resourceType: 'queue_entry', resourceId: entryId });
    return toEntry(updated);
  });
}

export async function history(context, entryId) {
  return withTenant(context, async (tx) => {
    const entry = await tx.emrQueueEntry.findFirst({ where: { organizationId: context.organizationId, id: entryId }, select: { id: true } });
    if (!entry) throw new EmrError('QUEUE_ENTRY_NOT_FOUND');
    return tx.emrQueueEvent.findMany({ where: { organizationId: context.organizationId, queueEntryId: entryId }, orderBy: { createdAt: 'asc' } });
  });
}
