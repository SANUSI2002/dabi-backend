// Encounter data access. Every function takes the tenant transaction from withTenant; explicit
// organizationId filters are defence in depth on top of row-level security.
import { Buffer } from 'node:buffer';
import { updateVersioned } from '../core/concurrency.js';

const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true, status: true } };
export const encounterSelect = {
  id: true, patientId: true, class: true, status: true, reason: true, attendingUserId: true, source: true, sourceReference: true,
  arrivedAt: true, startedAt: true, endedAt: true, cancellationReason: true, version: true, createdAt: true, updatedAt: true,
  patient: patientSummary,
};

export const encodeCursor = (row) => Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
export const decodeCursor = (cursor) => {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = new Date(createdAt);
  if (!id || Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { createdAt: date, id };
};

export async function listEncounters(tx, organizationId, { status, patientId, class: encounterClass, limit, after }) {
  const rows = await tx.emrEncounter.findMany({
    where: {
      organizationId,
      ...(status ? { status: { in: status } } : {}),
      ...(patientId ? { patientId } : {}),
      ...(encounterClass ? { class: encounterClass } : {}),
      ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
    },
    select: encounterSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]) : null };
}

export const findEncounter = (tx, organizationId, id) => tx.emrEncounter.findFirst({ where: { organizationId, id }, select: encounterSelect });

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

// ---- entries that are never edited, only marked "entered in error" ----
export async function markEnteredInError(model, { organizationId, encounterId, id, userId, reason, notFoundCode }) {
  const { count } = await model.updateMany({
    where: { organizationId, encounterId, id, status: 'ACTIVE' },
    data: { status: 'ENTERED_IN_ERROR', errorReason: reason, erroredByUserId: userId, erroredAt: new Date() },
  });
  const row = await model.findFirst({ where: { organizationId, encounterId, id } });
  if (!row) return { error: notFoundCode };
  if (count === 0) return { error: 'INVALID_STATE' };
  return { row };
}
