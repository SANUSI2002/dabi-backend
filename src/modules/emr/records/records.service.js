// The patient record: one read that gathers a patient's longitudinal chart (visits with their
// notes and diagnoses, vital signs, problem list, allergies, and — where the caller's role allows
// — laboratory, medicines, admissions and invoices), plus the problem list's own changes.
//
// Problem list: entries in emr_problems, plus any diagnosis a clinician flagged "on problem list"
// during a consultation that has no entry of the same code yet. Those appear with problemId null;
// the first status change turns one into a stored entry (POST with fromDiagnosisId).
import { withTenant } from '../core/db.js';
import { recordAudit, changedFieldNames } from '../core/audit.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';
import { toPatient } from '../patients/patients.service.js';
import { labOrdersForPatient } from '../lab/lab.service.js';
import { forPharmacy } from '../pharmacy/prescriptions.service.js';
import { LINE_ORDER, pharmacyPatient } from '../pharmacy/pharmacy.shared.js';
import { withPlaces } from '../admissions/admissions.service.js';
import { toCharge, toInvoice } from '../billing/billing.service.js';

const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
const asDate = (value) => (value ? new Date(`${value}T00:00:00.000Z`) : value);
const LIMIT = { appointments: 100, encounters: 100, labs: 100, prescriptions: 100, admissions: 50, invoices: 100, vitals: 2000 };
/** Statuses that mean the problem is ongoing; anything else ends it (abatement date). */
const ONGOING = ['ACTIVE', 'RECURRENCE', 'RELAPSE'];
const admissionPatient = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };

const toProblem = (row, name) => ({
  ...row,
  problemId: row.id,
  onsetDate: dateOnly(row.onsetDate),
  abatementDate: dateOnly(row.abatementDate),
  recordedByName: name(row.recordedByUserId),
  updatedByName: name(row.updatedByUserId),
});

async function requirePatient(tx, context, patientId) {
  const patient = await findPatient(tx, context.organizationId, patientId);
  if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
  return patient;
}

/** Stored problems first (newest first), then flagged diagnoses whose code is not on the list yet. */
function problemList(problems, diagnoses, name) {
  const listed = new Set(problems.map((p) => `${p.codeSystem}|${p.code}`));
  const pending = [];
  for (const d of diagnoses) {
    const key = `${d.codeSystem}|${d.code}`;
    if (!d.onProblemList || listed.has(key)) continue;
    listed.add(key);
    pending.push({
      id: `diagnosis:${d.id}`, problemId: null, fromDiagnosisId: d.id, patientId: d.patientId, encounterId: d.encounterId,
      code: d.code, codeSystem: d.codeSystem, description: d.description,
      clinicalStatus: 'ACTIVE', verificationStatus: null, onsetDate: null, abatementDate: null, note: null,
      recordedByName: name(d.recordedByUserId), updatedByName: null, createdAt: d.createdAt, version: null,
    });
  }
  return [...problems.map((p) => toProblem(p, name)), ...pending];
}

/**
 * The whole chart in one response. Sections the caller's role may not read come back as null and
 * `sections` says which were included, so the screen can tell "none recorded" from "not shown".
 */
export async function patientRecord(context, patientId) {
  const org = context.organizationId;
  const may = (...codes) => codes.some((code) => context.permissions.includes(code));
  const sections = {
    labs: may('lab.order.read'),
    prescriptions: may('prescription.read'),
    admissions: may('admission.read'),
    invoices: may('billing.read'),
    appointments: may('appointment.read'),
  };
  return withTenant(context, async (tx) => {
    const patient = await requirePatient(tx, context, patientId);
    const where = { organizationId: org, patientId };
    const encounters = await tx.emrEncounter.findMany({
      where, include: { queueEntry: { select: { station: true, status: true } } }, orderBy: [{ arrivedAt: 'desc' }, { id: 'desc' }], take: LIMIT.encounters,
    });
    const encounterIds = encounters.map((e) => e.id);
    const [notes, diagnoses, vitals, problems, allergies] = await Promise.all([
      tx.emrClinicalNote.findMany({ where: { organizationId: org, encounterId: { in: encounterIds } }, orderBy: { createdAt: 'asc' } }),
      tx.emrDiagnosis.findMany({ where: { ...where, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } }),
      tx.emrObservation.findMany({ where: { ...where, status: 'ACTIVE' }, orderBy: [{ recordedAt: 'asc' }, { code: 'asc' }], take: LIMIT.vitals }),
      tx.emrProblem.findMany({ where, orderBy: { createdAt: 'desc' } }),
      tx.emrPatientAllergy.findMany({ where: { ...where, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } }),
    ]);
    const amendments = notes.length
      ? await tx.emrNoteAmendment.findMany({ where: { organizationId: org, noteId: { in: notes.map((n) => n.id) } }, orderBy: { createdAt: 'asc' } })
      : [];

    const labs = sections.labs ? await labOrdersForPatient(tx, context, patientId, LIMIT.labs) : null;
    const prescriptions = sections.prescriptions
      ? await forPharmacy(tx, context, await tx.emrPrescription.findMany({
        where, include: { patient: pharmacyPatient, items: { orderBy: LINE_ORDER } }, orderBy: { createdAt: 'desc' }, take: LIMIT.prescriptions,
      }))
      : null;
    const admissions = sections.admissions
      ? await withPlaces(tx, context, await tx.emrAdmission.findMany({ where, include: { patient: admissionPatient }, orderBy: { admittedAt: 'desc' }, take: LIMIT.admissions }))
      : null;
    const appointments = sections.appointments
      ? await tx.emrAppointment.findMany({ where, orderBy: { scheduledAt: 'desc' }, take: LIMIT.appointments })
      : null;
    let invoices = null;
    if (sections.invoices) {
      const rows = await tx.emrInvoice.findMany({ where, orderBy: { issuedAt: 'desc' }, take: LIMIT.invoices });
      const lines = rows.length ? await tx.emrCharge.findMany({ where: { organizationId: org, invoiceId: { in: rows.map((i) => i.id) } }, orderBy: { serviceAt: 'asc' } }) : [];
      invoices = rows.map((row) => ({ ...toInvoice(row), lines: lines.filter((c) => c.invoiceId === row.id).map(toCharge) }));
    }

    const names = await userNameMap(tx, [
      ...encounters.map((e) => e.attendingUserId),
      ...notes.flatMap((n) => [n.authorUserId, n.signedByUserId]),
      ...amendments.map((a) => a.authorUserId),
      ...diagnoses.map((d) => d.recordedByUserId),
      ...vitals.map((o) => o.recordedByUserId),
      ...problems.flatMap((p) => [p.recordedByUserId, p.updatedByUserId]),
      ...allergies.flatMap((a) => [a.recordedByUserId, a.verifiedByUserId]),
      ...(appointments ?? []).map((a) => a.providerUserId),
    ]);
    const name = (id) => (id ? names.get(id) ?? null : null);

    await recordAudit(tx, context, { action: 'patient_record.viewed', resourceType: 'patient', resourceId: patientId });
    return {
      patient: toPatient(patient),
      encounters: encounters.map((e) => ({
        ...e,
        attendingName: name(e.attendingUserId),
        notes: notes.filter((n) => n.encounterId === e.id).map((n) => ({
          ...n,
          authorName: name(n.authorUserId),
          signedByName: name(n.signedByUserId),
          amendments: amendments.filter((a) => a.noteId === n.id).map((a) => ({ ...a, authorName: name(a.authorUserId) })),
        })),
        diagnoses: diagnoses.filter((d) => d.encounterId === e.id).reverse().map((d) => ({ ...d, recordedByName: name(d.recordedByUserId) })),
      })),
      vitals: vitals.map((o) => ({ ...o, value: Number(o.value), recordedByName: name(o.recordedByUserId) })),
      problems: problemList(problems, diagnoses, name),
      allergies: allergies.map((a) => ({ ...a, recordedByName: name(a.recordedByUserId), verifiedByName: name(a.verifiedByUserId) })),
      labs,
      prescriptions,
      admissions,
      invoices,
      appointments: appointments && appointments.map((a) => ({ ...a, providerName: name(a.providerUserId) })),
      sections,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Problem list
// ---------------------------------------------------------------------------------------------
const UNIQUE = { emr_problems_code_key: 'PROBLEM_ALREADY_RECORDED' };

/** Adds a problem: a coded entry, or one of the patient's diagnoses flagged during a visit. */
export async function addProblem(context, patientId, input) {
  try {
    return await withTenant(context, async (tx) => {
      await requirePatient(tx, context, patientId);
      let entry;
      if (input.fromDiagnosisId) {
        const diagnosis = await tx.emrDiagnosis.findFirst({ where: { organizationId: context.organizationId, patientId, id: input.fromDiagnosisId, status: 'ACTIVE' } });
        if (!diagnosis) throw new EmrError('DIAGNOSIS_NOT_FOUND');
        entry = {
          code: diagnosis.code, codeSystem: diagnosis.codeSystem, description: diagnosis.description,
          encounterId: diagnosis.encounterId, sourceDiagnosisId: diagnosis.id, onsetDate: new Date(`${dateOnly(diagnosis.createdAt)}T00:00:00.000Z`),
        };
      } else {
        entry = { code: input.code, codeSystem: input.codeSystem, description: input.description, onsetDate: asDate(input.onsetDate) ?? null };
      }
      const clinicalStatus = input.clinicalStatus ?? 'ACTIVE';
      const row = await tx.emrProblem.create({
        data: {
          ...entry,
          organizationId: context.organizationId, patientId,
          clinicalStatus,
          verificationStatus: input.verificationStatus ?? (input.fromDiagnosisId ? 'UNCONFIRMED' : 'PROVISIONAL'),
          abatementDate: ONGOING.includes(clinicalStatus) ? null : new Date(`${dateOnly(new Date())}T00:00:00.000Z`),
          note: input.note ?? null,
          recordedByUserId: context.userId,
        },
      });
      await recordAudit(tx, context, { action: 'problem.recorded', resourceType: 'problem', resourceId: row.id });
      await enqueueEvent(tx, context, { type: 'problem.recorded', aggregateType: 'patient', aggregateId: patientId, data: { problemId: row.id } });
      const names = await userNameMap(tx, [row.recordedByUserId]);
      return toProblem(row, (id) => (id ? names.get(id) ?? null : null));
    });
  } catch (error) {
    throw uniqueViolation(error, UNIQUE) ?? error;
  }
}

/** Changes a problem's clinical or verification status (resolving it records the date). */
export async function updateProblem(context, patientId, problemId, expectedVersion, changes) {
  return withTenant(context, async (tx) => {
    const current = await tx.emrProblem.findFirst({ where: { organizationId: context.organizationId, patientId, id: problemId } });
    if (!current) throw new EmrError('PROBLEM_NOT_FOUND');
    const data = { ...changes, updatedByUserId: context.userId };
    if ('abatementDate' in changes) data.abatementDate = asDate(changes.abatementDate) ?? null;
    if (changes.clinicalStatus && changes.clinicalStatus !== current.clinicalStatus) {
      if (ONGOING.includes(changes.clinicalStatus)) data.abatementDate = null;
      else if (!data.abatementDate && !current.abatementDate) data.abatementDate = new Date(`${dateOnly(new Date())}T00:00:00.000Z`);
    }
    const row = await updateVersioned(tx.emrProblem, { organizationId: context.organizationId, id: problemId, expectedVersion, data, notFoundCode: 'PROBLEM_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'problem.updated', resourceType: 'problem', resourceId: problemId, changedFields: changedFieldNames(current, changes) });
    await enqueueEvent(tx, context, { type: 'problem.updated', aggregateType: 'patient', aggregateId: patientId, data: { problemId } });
    const names = await userNameMap(tx, [row.recordedByUserId, row.updatedByUserId]);
    return toProblem(row, (id) => (id ? names.get(id) ?? null : null));
  });
}
