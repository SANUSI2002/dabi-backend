// Radiology: request → schedule → perform (series) → report → verify → addenda; cancel before the
// study is performed. Patient → Study → Series → Report, a DICOM-shaped record without images: no
// PACS/DICOM viewer is connected, and nothing here pretends otherwise.
//
// A study performed elsewhere (externalStudy) is recorded as already performed, for reference and
// reporting only, and is never billed here. Every change is audited and emits an event carrying
// identifiers only.
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { nextSequence } from '../core/sequence.js';
import { EmrError } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';
import { OPEN_STATUSES } from '../encounters/encounters.policy.js';

export const MODALITIES = ['XRAY', 'ULTRASOUND', 'CT', 'MRI', 'MAMMOGRAPHY', 'FLUOROSCOPY'];
const STUDY_PEOPLE = ['requestedByUserId', 'scheduledByUserId', 'performedByUserId', 'cancelledByUserId'];
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const full = { patient: patientSummary, series: { orderBy: { seriesNumber: 'asc' } }, report: true, addenda: { orderBy: { createdAt: 'asc' } } };
const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
const accessionNumber = (year, value) => `RAD-${year}-${String(value).padStart(6, '0')}`;

/** Names beside every staff id on the studies, their reports and addenda. */
export async function withStudyNames(tx, studies) {
  const names = await userNameMap(tx, studies.flatMap((s) => [
    ...STUDY_PEOPLE.map((f) => s[f]), s.report?.authorUserId, s.report?.verifiedByUserId, ...(s.addenda ?? []).map((a) => a.authorUserId),
  ]));
  const name = (id) => (id ? names.get(id) ?? null : null);
  return studies.map((s) => ({
    ...s,
    ...Object.fromEntries(STUDY_PEOPLE.map((f) => [f.replace(/UserId$/, 'Name'), name(s[f])])),
    scheduledFor: dateOnly(s.scheduledFor),
    ...(s.patient ? { patient: { ...s.patient, dateOfBirth: dateOnly(s.patient.dateOfBirth) } } : {}),
    report: s.report ? { ...s.report, authorName: name(s.report.authorUserId), verifiedByName: name(s.report.verifiedByUserId) } : null,
    addenda: (s.addenda ?? []).map((a) => ({ ...a, authorName: name(a.authorUserId) })),
  }));
}

const fullStudy = async (tx, context, id) =>
  (await withStudyNames(tx, [await tx.emrImagingStudy.findFirst({ where: { organizationId: context.organizationId, id }, include: full })]))[0];

async function load(tx, context, id, allowed, message) {
  const study = await tx.emrImagingStudy.findFirst({ where: { organizationId: context.organizationId, id } });
  if (!study) throw new EmrError('IMAGING_STUDY_NOT_FOUND');
  if (allowed && !allowed.includes(study.status)) throw new EmrError('INVALID_STATE', { message });
  return study;
}

async function done(tx, context, study, action, data = {}) {
  await recordAudit(tx, context, { action: `imaging_study.${action}`, resourceType: 'imaging_study', resourceId: study.id });
  await enqueueEvent(tx, context, { type: `imaging_study.${action}`, aggregateType: 'patient', aggregateId: study.patientId, data: { studyId: study.id, ...data } });
  return fullStudy(tx, context, study.id);
}

const move = (tx, context, study, expectedVersion, data) =>
  updateVersioned(tx.emrImagingStudy, { organizationId: context.organizationId, id: study.id, expectedVersion, data, notFoundCode: 'IMAGING_STUDY_NOT_FOUND' });

/** Studies newest first, optionally by status or patient, with series, report and names. */
export async function listStudies(context, { status, patientId, cursor, limit }) {
  const after = afterCursor('createdAt', cursor, 'desc');
  return withTenant(context, async (tx) => {
    const rows = await tx.emrImagingStudy.findMany({
      where: { organizationId: context.organizationId, ...(status ? { status: { in: status } } : {}), ...(patientId ? { patientId } : {}), ...after },
      include: full,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'imaging_study.listed', resourceType: 'imaging_study' });
    const result = page(rows, limit, 'createdAt');
    return { ...result, items: await withStudyNames(tx, result.items) };
  });
}

/** A request, attached to the patient's open visit when there is one (that is what gets billed). */
export async function requestStudy(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'imaging.request', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
    const open = await tx.emrEncounter.findFirst({
      where: { organizationId: context.organizationId, patientId: patient.id, status: { in: OPEN_STATUSES }, ...(input.encounterId ? { id: input.encounterId } : {}) },
      select: { id: true },
    });
    if (input.encounterId && !open) throw new EmrError('INVALID_STATE', { message: 'That visit is not open for this patient.' });
    const year = new Date().getUTCFullYear();
    const now = new Date();
    const study = await tx.emrImagingStudy.create({
      data: {
        organizationId: context.organizationId, patientId: patient.id, encounterId: open?.id ?? null,
        accessionNumber: accessionNumber(year, await nextSequence(tx, context, `imaging_accession_${year}`)),
        modality: input.modality, bodySite: input.bodySite, laterality: input.laterality ?? null, indication: input.indication,
        priority: input.priority, preparation: input.preparation ?? null, externalStudy: input.externalStudy,
        requestedByUserId: context.userId,
        // Done elsewhere: recorded as performed, for reference and reporting only.
        ...(input.externalStudy ? { status: 'PERFORMED', performedAt: now, performedByUserId: context.userId } : {}),
      },
    });
    return { statusCode: 201, body: await done(tx, context, study, 'requested', { encounterId: study.encounterId }) };
  }));
}

export async function scheduleStudy(context, id, expectedVersion, { scheduledFor }) {
  return withTenant(context, async (tx) => {
    const study = await load(tx, context, id, ['REQUESTED', 'SCHEDULED'], 'Only a requested study can be scheduled.');
    if (study.externalStudy) throw new EmrError('INVALID_STATE', { message: 'A study performed elsewhere is not scheduled here.' });
    await move(tx, context, study, expectedVersion, { status: 'SCHEDULED', scheduledFor: new Date(`${scheduledFor}T00:00:00.000Z`), scheduledByUserId: context.userId });
    return done(tx, context, study, 'scheduled');
  });
}

export async function performStudy(context, id, expectedVersion, { series }) {
  return withTenant(context, async (tx) => {
    const study = await load(tx, context, id, ['REQUESTED', 'SCHEDULED'], 'This study has already been performed or cancelled.');
    if (study.externalStudy) throw new EmrError('INVALID_STATE', { message: 'A study performed elsewhere is not performed here.' });
    await move(tx, context, study, expectedVersion, { status: 'PERFORMED', performedAt: new Date(), performedByUserId: context.userId });
    await tx.emrImagingSeries.createMany({
      data: series.map((s, index) => ({
        organizationId: context.organizationId, studyId: study.id, seriesNumber: index + 1,
        description: s.description, bodyPart: s.bodyPart ?? study.bodySite, imageCount: s.imageCount ?? null,
      })),
    });
    return done(tx, context, study, 'performed', { series: series.length });
  });
}

export async function reportStudy(context, id, expectedVersion, { findings, impression }) {
  return withTenant(context, async (tx) => {
    const study = await load(tx, context, id, ['PERFORMED'], 'Only a performed study without a report can be reported.');
    await move(tx, context, study, expectedVersion, { status: 'REPORTED' });
    await tx.emrImagingReport.create({ data: { organizationId: context.organizationId, studyId: study.id, findings, impression, authorUserId: context.userId } });
    return done(tx, context, study, 'reported');
  });
}

export async function verifyReport(context, id, expectedVersion) {
  return withTenant(context, async (tx) => {
    const study = await load(tx, context, id, ['REPORTED'], 'Only a drafted report can be verified.');
    await move(tx, context, study, expectedVersion, { status: 'VERIFIED' });
    await tx.emrImagingReport.updateMany({ where: { organizationId: context.organizationId, studyId: study.id, verifiedAt: null }, data: { verifiedByUserId: context.userId, verifiedAt: new Date() } });
    return done(tx, context, study, 'verified');
  });
}

/** A verified report is never edited; corrections and additions are appended. */
export async function addAddendum(context, id, expectedVersion, { note }) {
  return withTenant(context, async (tx) => {
    const study = await load(tx, context, id, ['VERIFIED', 'AMENDED'], 'Addenda are added to verified reports.');
    await move(tx, context, study, expectedVersion, { status: 'AMENDED' });
    await tx.emrImagingAddendum.create({ data: { organizationId: context.organizationId, studyId: study.id, note, authorUserId: context.userId } });
    return done(tx, context, study, 'amended');
  });
}

export async function cancelStudy(context, id, expectedVersion, { reason }) {
  return withTenant(context, async (tx) => {
    const study = await load(tx, context, id, ['REQUESTED', 'SCHEDULED'],
      'A performed study cannot be cancelled; record what happened in its report or an addendum instead.');
    await move(tx, context, study, expectedVersion, { status: 'CANCELLED', cancelledAt: new Date(), cancelledByUserId: context.userId, cancellationReason: reason });
    return done(tx, context, study, 'cancelled');
  });
}

/** Points a study at one of the patient's earlier verified studies, for the reporter to compare. */
export async function setComparison(context, id, expectedVersion, { compareToStudyId }) {
  return withTenant(context, async (tx) => {
    const study = await load(tx, context, id);
    if (compareToStudyId) {
      const prior = await tx.emrImagingStudy.findFirst({
        where: { organizationId: context.organizationId, id: compareToStudyId, patientId: study.patientId, status: { in: ['VERIFIED', 'AMENDED'] }, NOT: { id: study.id } },
        select: { id: true },
      });
      if (!prior) throw new EmrError('VALIDATION_FAILED', { message: 'Compare with one of this patient’s earlier verified studies.' });
    }
    await move(tx, context, study, expectedVersion, { compareToStudyId: compareToStudyId ?? null });
    return done(tx, context, study, 'comparison_set');
  });
}
