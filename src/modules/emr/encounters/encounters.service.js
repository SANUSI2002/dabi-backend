// Encounter use cases: check-in, visit lifecycle, clinical notes (sign → locked, amendments),
// vital signs and diagnoses. Every change is audited and emits an outbox event in the same
// transaction. Events carry identifiers only — never note text, values or codes.
import prisma from '../../../config/db.js';
import { withTenant } from '../core/db.js';
import { recordAudit, changedFieldNames } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { afterCursor } from '../core/cursor.js';
import { markEnteredInError } from '../core/entries.js';
import { enqueueEvent } from '../core/outbox.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { findPatient } from '../patients/patients.repository.js';
import * as repo from './encounters.repository.js';
import * as policy from './encounters.policy.js';

const UNIQUE = {
  one_open_per_patient: 'ENCOUNTER_ALREADY_OPEN',
  source_reference: 'ENCOUNTER_ALREADY_OPEN',
  one_primary: 'PRIMARY_DIAGNOSIS_EXISTS',
};
const mapped = async (promise) => {
  try { return await promise; } catch (error) { throw uniqueViolation(error, UNIQUE) ?? error; }
};

const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
export const toEncounter = (row) => (row.patient ? { ...row, patient: { ...row.patient, dateOfBirth: dateOnly(row.patient.dateOfBirth) } } : row);
const toObservation = (row) => ({ ...row, value: Number(row.value) });

async function loadEncounter(tx, context, encounterId) {
  const encounter = await repo.findEncounter(tx, context.organizationId, encounterId);
  if (!encounter) throw new EmrError('ENCOUNTER_NOT_FOUND');
  return encounter;
}

// The attending clinician must be an active doctor of THIS organization. Memberships are not EMR
// tables, so this is checked before the tenant transaction opens.
async function requireAttending(context, userId) {
  if (!userId) return;
  const membership = await prisma.organizationMembership.findFirst({
    where: { userId, organizationId: context.organizationId, status: 'ACTIVE', roles: { some: { roleCode: 'DOCTOR' } } },
    select: { id: true },
  });
  if (!membership) throw new EmrError('VALIDATION_FAILED', { message: 'The attending clinician must be an active doctor in this organization.' });
}

// ---------------------------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------------------------
export async function openEncounter(context, input, { idempotencyKey } = {}) {
  await requireAttending(context, input.attendingUserId);
  return mapped(withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'encounter.open', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE'); // UC-17
    const row = await tx.emrEncounter.create({
      data: { organizationId: context.organizationId, patientId: patient.id, class: input.class, reason: input.reason, attendingUserId: input.attendingUserId, createdByUserId: context.userId },
      select: repo.encounterSelect,
    });
    await recordAudit(tx, context, { action: 'encounter.created', resourceType: 'encounter', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'encounter.created', aggregateType: 'encounter', aggregateId: row.id, data: { patientId: patient.id, class: row.class } });
    return { statusCode: 201, body: toEncounter(row) };
  })));
}

export async function listEncounters(context, query) {
  const after = afterCursor('createdAt', query.cursor);
  return withTenant(context, async (tx) => {
    const result = await repo.listEncounters(tx, context.organizationId, { ...query, after });
    await recordAudit(tx, context, { action: 'encounter.listed', resourceType: 'encounter' });
    return { ...result, items: result.items.map(toEncounter) };
  });
}

export async function getEncounter(context, encounterId) {
  return withTenant(context, async (tx) => {
    const encounter = await loadEncounter(tx, context, encounterId);
    const drafts = await tx.emrClinicalNote.count({ where: { organizationId: context.organizationId, encounterId, status: 'DRAFT' } });
    await recordAudit(tx, context, { action: 'encounter.viewed', resourceType: 'encounter', resourceId: encounterId });
    return { ...toEncounter(encounter), unsignedNotes: drafts };
  });
}

export async function updateEncounter(context, encounterId, expectedVersion, changes) {
  await requireAttending(context, changes.attendingUserId);
  return withTenant(context, async (tx) => {
    const current = await loadEncounter(tx, context, encounterId);
    policy.requireOpen(current);
    const row = await repo.updateEncounter(tx, { organizationId: context.organizationId, id: encounterId, expectedVersion, data: { ...changes, updatedByUserId: context.userId } });
    await recordAudit(tx, context, { action: 'encounter.updated', resourceType: 'encounter', resourceId: encounterId, changedFields: changedFieldNames(current, changes) });
    return toEncounter(row);
  });
}

export async function transitionEncounter(context, encounterId, expectedVersion, action, input = {}) {
  return withTenant(context, async (tx) => {
    const current = await repo.lockEncounter(tx, context.organizationId, encounterId);
    if (!current) throw new EmrError('ENCOUNTER_NOT_FOUND');
    const data = policy.transitionData(action, current, input);
    if (action !== 'start') {
      // An inpatient stay is closed by discharge (or cancelling the admission), never around it.
      const admitted = await tx.emrAdmission.count({ where: { organizationId: context.organizationId, encounterId, status: 'ADMITTED' } });
      if (admitted) throw new EmrError('INVALID_STATE', { message: 'The patient is admitted on this visit; discharge them (or cancel the admission) first.' });
    }
    const row = await repo.updateEncounter(tx, { organizationId: context.organizationId, id: encounterId, expectedVersion, data: { ...data, updatedByUserId: context.userId } });
    const type = { start: 'encounter.started', finish: 'encounter.finished', cancel: 'encounter.cancelled' }[action];
    await recordAudit(tx, context, { action: type, resourceType: 'encounter', resourceId: encounterId, changedFields: Object.keys(data) });
    await enqueueEvent(tx, context, { type, aggregateType: 'encounter', aggregateId: encounterId, data: { patientId: current.patientId, status: row.status } });
    return toEncounter(row);
  });
}

// ---------------------------------------------------------------------------------------------
// Clinical notes
// ---------------------------------------------------------------------------------------------
export async function listNotes(context, encounterId) {
  return withTenant(context, async (tx) => {
    await loadEncounter(tx, context, encounterId);
    const notes = await repo.listNotes(tx, context.organizationId, encounterId);
    await recordAudit(tx, context, { action: 'clinical_note.viewed', resourceType: 'encounter', resourceId: encounterId });
    return notes;
  });
}

export async function createNote(context, encounterId, input) {
  policy.requireSignableKind(context, input.kind);
  if (!policy.hasContent(input)) throw new EmrError('VALIDATION_FAILED', { message: 'A note needs some content.' });
  return withTenant(context, async (tx) => {
    const encounter = await loadEncounter(tx, context, encounterId);
    policy.requireNotCancelled(encounter);
    const note = await tx.emrClinicalNote.create({
      data: { ...input, organizationId: context.organizationId, encounterId, patientId: encounter.patientId, authorUserId: context.userId },
    });
    await recordAudit(tx, context, { action: 'clinical_note.drafted', resourceType: 'clinical_note', resourceId: note.id });
    return { ...note, amendments: [] };
  });
}

export async function updateNote(context, encounterId, noteId, expectedVersion, changes) {
  return withTenant(context, async (tx) => {
    const note = await repo.findNote(tx, context.organizationId, encounterId, noteId);
    if (!note) throw new EmrError('NOTE_NOT_FOUND');
    policy.requireEditableDraft(context, note);
    if (!policy.hasContent({ ...note, ...changes })) throw new EmrError('VALIDATION_FAILED', { message: 'A note needs some content.' });
    const row = await repo.updateNote(tx, { organizationId: context.organizationId, id: noteId, expectedVersion, data: changes });
    await recordAudit(tx, context, { action: 'clinical_note.edited', resourceType: 'clinical_note', resourceId: noteId, changedFields: changedFieldNames(note, changes) });
    return { ...row, amendments: [] };
  });
}

export async function signNote(context, encounterId, noteId, expectedVersion) {
  return withTenant(context, async (tx) => {
    const note = await repo.findNote(tx, context.organizationId, encounterId, noteId);
    if (!note) throw new EmrError('NOTE_NOT_FOUND');
    policy.requireEditableDraft(context, note);
    policy.requireSignableKind(context, note.kind);
    if (!policy.hasContent(note)) throw new EmrError('VALIDATION_FAILED', { message: 'An empty note cannot be signed.' });
    const row = await repo.updateNote(tx, { organizationId: context.organizationId, id: noteId, expectedVersion, data: { status: 'SIGNED', signedByUserId: context.userId, signedAt: new Date() } });
    await recordAudit(tx, context, { action: 'clinical_note.signed', resourceType: 'clinical_note', resourceId: noteId });
    await enqueueEvent(tx, context, { type: 'clinical_note.signed', aggregateType: 'clinical_note', aggregateId: noteId, data: { encounterId, patientId: note.patientId, kind: note.kind } });
    return { ...row, amendments: [] };
  });
}

/** UC-16: the signed original is never touched; the correction is a new, append-only row. */
export async function amendNote(context, encounterId, noteId, { reason, body }) {
  return withTenant(context, async (tx) => {
    const note = await repo.findNote(tx, context.organizationId, encounterId, noteId);
    if (!note) throw new EmrError('NOTE_NOT_FOUND');
    if (note.status !== 'SIGNED') throw new EmrError('INVALID_STATE', { message: 'Only a signed note can be amended; edit the draft instead.' });
    policy.requireSignableKind(context, note.kind);
    const amendment = await tx.emrNoteAmendment.create({ data: { organizationId: context.organizationId, noteId, authorUserId: context.userId, reason, body } });
    await recordAudit(tx, context, { action: 'clinical_note.amended', resourceType: 'clinical_note', resourceId: noteId });
    await enqueueEvent(tx, context, { type: 'clinical_note.amended', aggregateType: 'clinical_note', aggregateId: noteId, data: { encounterId, patientId: note.patientId, amendmentId: amendment.id } });
    const amendments = await tx.emrNoteAmendment.findMany({ where: { organizationId: context.organizationId, noteId }, orderBy: { createdAt: 'asc' } });
    return { ...note, amendments };
  });
}

// ---------------------------------------------------------------------------------------------
// Vital signs
// ---------------------------------------------------------------------------------------------
export async function listVitals(context, encounterId) {
  return withTenant(context, async (tx) => {
    await loadEncounter(tx, context, encounterId);
    const rows = await tx.emrObservation.findMany({ where: { organizationId: context.organizationId, encounterId }, orderBy: [{ recordedAt: 'asc' }, { code: 'asc' }] });
    await recordAudit(tx, context, { action: 'vitals.viewed', resourceType: 'encounter', resourceId: encounterId });
    return rows.map(toObservation);
  });
}

export async function recordVitals(context, encounterId, { recordedAt, readings }) {
  policy.checkVitals(readings);
  const when = recordedAt ? new Date(recordedAt) : new Date();
  if (when.getTime() > Date.now() + 5 * 60_000) throw new EmrError('VALIDATION_FAILED', { message: 'Vital signs cannot be recorded in the future.' });
  return withTenant(context, async (tx) => {
    const encounter = await loadEncounter(tx, context, encounterId);
    policy.requireOpen(encounter);
    if (when < new Date(encounter.arrivedAt.getTime() - 60 * 60_000)) throw new EmrError('VALIDATION_FAILED', { message: 'Vital signs cannot predate the visit.' });
    const rows = await tx.emrObservation.createManyAndReturn({
      data: readings.map(({ code, value }) => ({
        organizationId: context.organizationId, encounterId, patientId: encounter.patientId, code, value, unit: policy.VITALS[code].unit,
        recordedByUserId: context.userId, recordedAt: when,
      })),
    });
    await recordAudit(tx, context, { action: 'vitals.recorded', resourceType: 'encounter', resourceId: encounterId, changedFields: readings.map((r) => r.code) });
    await enqueueEvent(tx, context, { type: 'vitals.recorded', aggregateType: 'encounter', aggregateId: encounterId, data: { patientId: encounter.patientId, count: rows.length } });
    return rows.map(toObservation);
  });
}

export async function markVitalError(context, encounterId, observationId, { reason }) {
  return withTenant(context, async (tx) => {
    await loadEncounter(tx, context, encounterId);
    const row = await markEnteredInError(tx.emrObservation, {
      where: { organizationId: context.organizationId, encounterId, id: observationId }, userId: context.userId, reason, notFoundCode: 'OBSERVATION_NOT_FOUND', label: 'reading',
    });
    await recordAudit(tx, context, { action: 'vitals.entered_in_error', resourceType: 'observation', resourceId: observationId });
    return toObservation(row);
  });
}

// ---------------------------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------------------------
export async function listDiagnoses(context, encounterId) {
  return withTenant(context, async (tx) => {
    await loadEncounter(tx, context, encounterId);
    const rows = await tx.emrDiagnosis.findMany({ where: { organizationId: context.organizationId, encounterId }, orderBy: { createdAt: 'asc' } });
    await recordAudit(tx, context, { action: 'diagnosis.viewed', resourceType: 'encounter', resourceId: encounterId });
    return rows;
  });
}

export async function recordDiagnosis(context, encounterId, input) {
  return mapped(withTenant(context, async (tx) => {
    const encounter = await loadEncounter(tx, context, encounterId);
    policy.requireNotCancelled(encounter);
    const row = await tx.emrDiagnosis.create({ data: { ...input, organizationId: context.organizationId, encounterId, patientId: encounter.patientId, recordedByUserId: context.userId } });
    await recordAudit(tx, context, { action: 'diagnosis.recorded', resourceType: 'diagnosis', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'diagnosis.recorded', aggregateType: 'encounter', aggregateId: encounterId, data: { patientId: encounter.patientId, diagnosisId: row.id } });
    return row;
  }));
}

export async function markDiagnosisError(context, encounterId, diagnosisId, { reason }) {
  return withTenant(context, async (tx) => {
    await loadEncounter(tx, context, encounterId);
    const row = await markEnteredInError(tx.emrDiagnosis, {
      where: { organizationId: context.organizationId, encounterId, id: diagnosisId }, userId: context.userId, reason, notFoundCode: 'DIAGNOSIS_NOT_FOUND', label: 'diagnosis',
    });
    await recordAudit(tx, context, { action: 'diagnosis.entered_in_error', resourceType: 'diagnosis', resourceId: diagnosisId });
    return row;
  });
}
