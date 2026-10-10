// Minor / outpatient procedures (e.g. incision and drainage, IUCD insertion, suturing) — not a
// theatre system. Request → schedule (performer, assistants) → consent → safety checklist →
// pre-procedure → performed (operative note) → recovery → follow-up; the note is signed by the
// performer and corrected only by amendments. Cancel only before the procedure is performed.
//
// The WHO-style safety checklist is created with the request; every item must be ticked or carry
// an exception reason before the procedure can be recorded as performed. Every change is audited
// and emits an event carrying identifiers only.
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError } from '../core/errors.js';
import { activeMemberWithPermission } from '../core/membership.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';
import { OPEN_STATUSES } from '../encounters/encounters.policy.js';

export const CHECKLIST = [
  ['SIGN_IN', 'Patient identity, site and procedure confirmed'],
  ['SIGN_IN', 'Consent confirmed'],
  ['SIGN_IN', 'Site marked (if applicable)'],
  ['SIGN_IN', 'Known allergies reviewed'],
  ['TIME_OUT', 'Team introduced; procedure and site confirmed aloud'],
  ['TIME_OUT', 'Equipment and instruments confirmed available'],
  ['TIME_OUT', 'Antibiotic prophylaxis given (or not indicated)'],
  ['SIGN_OUT', 'Instrument, sponge and needle counts correct'],
  ['SIGN_OUT', 'Specimen labelled (if applicable)'],
  ['SIGN_OUT', 'Key concerns for recovery communicated'],
];
const BEFORE_PERFORMED = ['REQUESTED', 'SCHEDULED', 'CONSENTED', 'PRE_PROCEDURE'];
const AFTER_PERFORMED = ['PERFORMED', 'RECOVERY', 'FOLLOW_UP'];
const PEOPLE = ['requestedByUserId', 'scheduledByUserId', 'performerUserId', 'consentObtainedByUserId', 'performedByUserId', 'noteSignedByUserId', 'cancelledByUserId'];
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const full = { patient: patientSummary, checklist: { orderBy: { position: 'asc' } }, amendments: { orderBy: { createdAt: 'asc' } } };
const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

/** The price-list reference for a procedure: its name as a code (e.g. INCISION_AND_DRAINAGE). */
export const procedureCode = (name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32).replace(/_+$/, '') || 'PROCEDURE';

/** Names beside every staff id on the procedures, their checklists and amendments. */
export async function withProcedureNames(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((p) => [
    ...PEOPLE.map((f) => p[f]), ...p.assistantUserIds, ...(p.checklist ?? []).map((i) => i.updatedByUserId), ...(p.amendments ?? []).map((a) => a.authorUserId),
  ]));
  const name = (id) => (id ? names.get(id) ?? null : null);
  return rows.map((p) => ({
    ...p,
    ...Object.fromEntries(PEOPLE.map((f) => [f.replace(/UserId$/, 'Name'), name(p[f])])),
    assistants: p.assistantUserIds.map((id) => ({ userId: id, name: name(id) })),
    scheduledFor: dateOnly(p.scheduledFor),
    ...(p.patient ? { patient: { ...p.patient, dateOfBirth: dateOnly(p.patient.dateOfBirth) } } : {}),
    checklist: (p.checklist ?? []).map((i) => ({ ...i, updatedByName: name(i.updatedByUserId) })),
    amendments: (p.amendments ?? []).map((a) => ({ ...a, authorName: name(a.authorUserId) })),
  }));
}

const fullProcedure = async (tx, context, id) =>
  (await withProcedureNames(tx, [await tx.emrProcedure.findFirst({ where: { organizationId: context.organizationId, id }, include: full })]))[0];

async function load(tx, context, id, allowed, message) {
  const row = await tx.emrProcedure.findFirst({ where: { organizationId: context.organizationId, id } });
  if (!row) throw new EmrError('PROCEDURE_NOT_FOUND');
  if (allowed && !allowed.includes(row.status)) throw new EmrError('INVALID_STATE', { message });
  return row;
}

async function done(tx, context, row, action, data = {}) {
  await recordAudit(tx, context, { action: `procedure.${action}`, resourceType: 'procedure', resourceId: row.id });
  await enqueueEvent(tx, context, { type: `procedure.${action}`, aggregateType: 'patient', aggregateId: row.patientId, data: { procedureId: row.id, ...data } });
  return fullProcedure(tx, context, row.id);
}

const move = (tx, context, row, expectedVersion, data) =>
  updateVersioned(tx.emrProcedure, { organizationId: context.organizationId, id: row.id, expectedVersion, data, notFoundCode: 'PROCEDURE_NOT_FOUND' });

/** Colleagues named on a procedure must be active members who may perform procedures. */
async function requireClinicians(context, userIds, label) {
  for (const userId of new Set(userIds.filter(Boolean))) {
    if (!(await activeMemberWithPermission(context.organizationId, userId, 'procedure.perform'))) {
      throw new EmrError('VALIDATION_FAILED', { message: `The ${label} must be an active clinician in this organization.` });
    }
  }
}

export async function listProcedures(context, { status, patientId, cursor, limit }) {
  const after = afterCursor('createdAt', cursor, 'desc');
  return withTenant(context, async (tx) => {
    const rows = await tx.emrProcedure.findMany({
      where: { organizationId: context.organizationId, ...(status ? { status: { in: status } } : {}), ...(patientId ? { patientId } : {}), ...after },
      include: full,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'procedure.listed', resourceType: 'procedure' });
    const result = page(rows, limit, 'createdAt');
    return { ...result, items: await withProcedureNames(tx, result.items) };
  });
}

/** A request with its checklist, attached to the patient's open visit when there is one (what gets billed). */
export async function requestProcedure(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'procedure.request', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
    const open = await tx.emrEncounter.findFirst({
      where: { organizationId: context.organizationId, patientId: patient.id, status: { in: OPEN_STATUSES }, ...(input.encounterId ? { id: input.encounterId } : {}) },
      select: { id: true },
    });
    if (input.encounterId && !open) throw new EmrError('INVALID_STATE', { message: 'That visit is not open for this patient.' });
    const row = await tx.emrProcedure.create({
      data: {
        organizationId: context.organizationId, patientId: patient.id, encounterId: open?.id ?? null,
        name: input.name, code: procedureCode(input.name), indication: input.indication, bodySite: input.bodySite ?? null,
        laterality: input.laterality ?? null, priority: input.priority, requestedByUserId: context.userId,
      },
    });
    await tx.emrProcedureChecklistItem.createMany({
      data: CHECKLIST.map(([phase, label], position) => ({ organizationId: context.organizationId, procedureId: row.id, phase, label, position })),
    });
    return { statusCode: 201, body: await done(tx, context, row, 'requested', { encounterId: row.encounterId }) };
  }));
}

export async function scheduleProcedure(context, id, expectedVersion, { scheduledFor, performerUserId, assistantUserIds }) {
  await requireClinicians(context, [performerUserId], 'performer');
  await requireClinicians(context, assistantUserIds, 'assistant');
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id, ['REQUESTED', 'SCHEDULED'], 'Only a requested procedure can be scheduled.');
    await move(tx, context, row, expectedVersion, {
      status: 'SCHEDULED', scheduledFor: new Date(`${scheduledFor}T00:00:00.000Z`), performerUserId, assistantUserIds, scheduledByUserId: context.userId,
    });
    return done(tx, context, row, 'scheduled');
  });
}

export async function recordConsent(context, id, expectedVersion, { obtainedByUserId }) {
  if (!(await activeMemberWithPermission(context.organizationId, obtainedByUserId, 'vitals.record'))) {
    throw new EmrError('VALIDATION_FAILED', { message: 'Consent must be obtained by an active clinician in this organization.' });
  }
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id, ['SCHEDULED'], 'Consent is recorded once the procedure is scheduled.');
    await move(tx, context, row, expectedVersion, { status: 'CONSENTED', consentObtainedByUserId: obtainedByUserId, consentAt: new Date() });
    return done(tx, context, row, 'consented');
  });
}

/** Ticks a checklist item, or records why it does not apply. Only between consent and performing. */
export async function setChecklistItem(context, id, itemId, { completed, exceptionReason }) {
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id, ['CONSENTED', 'PRE_PROCEDURE'], 'The safety checklist is completed between consent and the procedure.');
    const { count } = await tx.emrProcedureChecklistItem.updateMany({
      where: { organizationId: context.organizationId, procedureId: row.id, id: itemId },
      data: { completed, exceptionReason: completed ? null : exceptionReason ?? null, updatedByUserId: context.userId, updatedAt: new Date() },
    });
    if (!count) throw new EmrError('PROCEDURE_NOT_FOUND', { message: 'Checklist item not found.' });
    return done(tx, context, row, 'checklist_updated', { itemId });
  });
}

export async function beginPreProcedure(context, id, expectedVersion) {
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id, ['CONSENTED'], 'Only a consented procedure moves to pre-procedure.');
    await move(tx, context, row, expectedVersion, { status: 'PRE_PROCEDURE', preProcedureAt: new Date() });
    return done(tx, context, row, 'pre_procedure');
  });
}

export async function performProcedure(context, id, expectedVersion, input) {
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id, ['PRE_PROCEDURE'], 'A procedure is performed after its pre-procedure checks.');
    const open = await tx.emrProcedureChecklistItem.findMany({
      where: { organizationId: context.organizationId, procedureId: row.id, completed: false, exceptionReason: null },
      orderBy: { position: 'asc' }, select: { label: true },
    });
    if (open.length) {
      throw new EmrError('VALIDATION_FAILED', { message: `Complete the safety checklist first (tick each item or give a reason): ${open.map((i) => i.label).join('; ')}.` });
    }
    await move(tx, context, row, expectedVersion, {
      status: 'PERFORMED', performedAt: new Date(), performedByUserId: context.userId,
      anaesthesia: input.anaesthesia ?? null, device: input.device ?? null, complications: input.complications ?? 'None',
      outcome: input.outcome, findings: input.findings ?? null, specimenSentToLab: input.specimenSentToLab,
    });
    return done(tx, context, row, 'performed');
  });
}

export async function recordRecovery(context, id, expectedVersion, { recoveryNotes }) {
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id, ['PERFORMED'], 'Recovery follows the procedure.');
    await move(tx, context, row, expectedVersion, { status: 'RECOVERY', recoveryNotes, recoveryAt: new Date() });
    return done(tx, context, row, 'recovery');
  });
}

export async function setFollowUp(context, id, expectedVersion, { followUpPlan }) {
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id, ['RECOVERY'], 'The follow-up plan is set after recovery.');
    await move(tx, context, row, expectedVersion, { status: 'FOLLOW_UP', followUpPlan, followUpAt: new Date() });
    return done(tx, context, row, 'follow_up');
  });
}

/** The performer signs the procedure note (anyone performing procedures when no performer was named). */
export async function signNote(context, id, expectedVersion) {
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id, AFTER_PERFORMED, 'The note is signed once the procedure has been performed.');
    if (row.noteSignedAt) throw new EmrError('INVALID_STATE', { message: 'This note is already signed; add an amendment instead.' });
    if (row.performerUserId && row.performerUserId !== context.userId) throw new EmrError('PERMISSION_DENIED', { message: 'Only the performer can sign this note.' });
    await move(tx, context, row, expectedVersion, { noteSignedByUserId: context.userId, noteSignedAt: new Date() });
    return done(tx, context, row, 'note_signed');
  });
}

/** A signed note is never edited; corrections are appended. */
export async function amendNote(context, id, { note }) {
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id);
    if (!row.noteSignedAt) throw new EmrError('INVALID_STATE', { message: 'Only a signed note can be amended.' });
    await tx.emrProcedureAmendment.create({ data: { organizationId: context.organizationId, procedureId: row.id, note, authorUserId: context.userId } });
    return done(tx, context, row, 'note_amended');
  });
}

export async function cancelProcedure(context, id, expectedVersion, { reason }) {
  return withTenant(context, async (tx) => {
    const row = await load(tx, context, id, BEFORE_PERFORMED, 'A performed procedure cannot be cancelled; record what happened in its note or an amendment.');
    await move(tx, context, row, expectedVersion, { status: 'CANCELLED', cancelledAt: new Date(), cancelledByUserId: context.userId, cancellationReason: reason });
    return done(tx, context, row, 'cancelled');
  });
}
