// Encounter data access. Every function takes the tenant transaction from withTenant; explicit
// organizationId filters are defence in depth on top of row-level security.
import { updateVersioned } from '../core/concurrency.js';
import { page } from '../core/cursor.js';

const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true, status: true } };
export const encounterSelect = {
  id: true, patientId: true, class: true, status: true, reason: true, attendingUserId: true, source: true, sourceReference: true,
  arrivedAt: true, startedAt: true, endedAt: true, cancellationReason: true, version: true, createdAt: true, updatedAt: true,
  patient: patientSummary,
  queueEntry: { select: { id: true, station: true, priority: true, status: true, queuedAt: true, version: true } },
};

export async function listEncounters(tx, organizationId, { status, patientId, class: encounterClass, limit, after }) {
  const rows = await tx.emrEncounter.findMany({
    where: {
      organizationId,
      ...(status ? { status: { in: status } } : {}),
      ...(patientId ? { patientId } : {}),
      ...(encounterClass ? { class: encounterClass } : {}),
      ...after,
    },
    select: encounterSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return page(rows, limit, 'createdAt');
}

export const findEncounter = (tx, organizationId, id) => tx.emrEncounter.findFirst({ where: { organizationId, id }, select: encounterSelect });

/**
 * Locks the visit row for the rest of the transaction. Status changes (start/finish/cancel) and
 * admission take this lock first, so they cannot interleave: an admission never lands on a visit
 * that is being cancelled, and a visit is never closed under a patient being admitted.
 */
export async function lockEncounter(tx, organizationId, id) {
  const rows = await tx.$queryRaw`SELECT "id" FROM "emr_encounters" WHERE "organization_id" = ${organizationId} AND "id" = ${id} FOR UPDATE`;
  return rows.length ? findEncounter(tx, organizationId, id) : null;
}

export const updateEncounter = (tx, { organizationId, id, expectedVersion, data }) =>
  updateVersioned(tx.emrEncounter, { organizationId, id, expectedVersion, data, select: encounterSelect, notFoundCode: 'ENCOUNTER_NOT_FOUND' });

// ---- notes ----
export async function listNotes(tx, organizationId, encounterId) {
  const notes = await tx.emrClinicalNote.findMany({ where: { organizationId, encounterId }, orderBy: { createdAt: 'asc' } });
  const amendments = notes.length
    ? await tx.emrNoteAmendment.findMany({ where: { organizationId, noteId: { in: notes.map((n) => n.id) } }, orderBy: { createdAt: 'asc' } })
    : [];
  return notes.map((note) => ({ ...note, amendments: amendments.filter((a) => a.noteId === note.id) }));
}

export const findNote = (tx, organizationId, encounterId, id) => tx.emrClinicalNote.findFirst({ where: { organizationId, encounterId, id } });

export const updateNote = (tx, { organizationId, id, expectedVersion, data }) =>
  updateVersioned(tx.emrClinicalNote, { organizationId, id, expectedVersion, data, notFoundCode: 'NOTE_NOT_FOUND' });
