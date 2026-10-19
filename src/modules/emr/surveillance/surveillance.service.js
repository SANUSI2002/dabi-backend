// Disease surveillance (IDSR). Staff notify suspected notifiable-disease cases; a doctor confirms or
// discards each one. Whether a disease needs immediate (24-hour) notification comes from the IDSR list
// below, not the form. A serious AEFI opens a suspected AEFI case (see immunizations.service.js).
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';

// Nigeria IDSR priority diseases as the Surveillance screen lists them, plus AEFI.
export const DISEASES = [
  { code: 'MAL', name: 'Malaria', class: 'IDSR Weekly', immediate: false },
  { code: 'MEAS', name: 'Measles', class: 'IDSR Immediate', immediate: true },
  { code: 'CHOL', name: 'Cholera', class: 'IDSR Immediate', immediate: true },
  { code: 'AFP', name: 'Acute Flaccid Paralysis', class: 'IDSR Immediate', immediate: true },
  { code: 'TB', name: 'Tuberculosis', class: 'IDSR Monthly', immediate: false },
  { code: 'HIV', name: 'HIV/AIDS', class: 'IDSR Monthly', immediate: false },
  { code: 'MDTH', name: 'Maternal Death', class: 'IDSR Immediate', immediate: true },
  { code: 'LF', name: 'Lassa Fever', class: 'IDSR Immediate', immediate: true },
  { code: 'MENI', name: 'Meningitis', class: 'IDSR Immediate', immediate: true },
  { code: 'YF', name: 'Yellow Fever', class: 'IDSR Immediate', immediate: true },
  { code: 'AWD', name: 'Acute Watery Diarrhoea', class: 'IDSR Weekly', immediate: false },
  { code: 'DYS', name: 'Bloody Diarrhoea (Dysentery)', class: 'IDSR Weekly', immediate: false },
  { code: 'COVID', name: 'COVID-19', class: 'IDSR Immediate', immediate: true },
  { code: 'AEFI', name: 'Adverse Event Following Immunization', class: 'IDSR Immediate', immediate: true },
];
export const DISEASE_CODES = DISEASES.map((d) => d.code);
const disease = (code) => DISEASES.find((d) => d.code === code);
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };

async function present(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((c) => [c.reportedByUserId, c.classifiedByUserId]));
  const name = (id) => (id ? names.get(id) ?? null : null);
  return rows.map((c) => ({
    id: c.id, patientId: c.patientId, patient: c.patient ? { ...c.patient, dateOfBirth: isoDay(c.patient.dateOfBirth) } : undefined, version: c.version,
    diseaseCode: c.diseaseCode, diseaseName: c.diseaseName, immediate: c.immediate, onsetDate: isoDay(c.onsetDate), notes: c.notes, source: c.source,
    status: c.status, reportedAt: c.reportedAt, reportedByName: name(c.reportedByUserId), classifiedAt: c.classifiedAt, classifiedByName: name(c.classifiedByUserId),
    classificationNote: c.classificationNote,
  }));
}
const fullCase = async (tx, context, id) =>
  (await present(tx, [await tx.emrSurveillanceCase.findFirst({ where: { organizationId: context.organizationId, id }, include: { patient: patientSummary } })]))[0];

async function notified(tx, context, row) {
  await recordAudit(tx, context, { action: 'surveillance.notified', resourceType: 'surveillance_case', resourceId: row.id });
  await enqueueEvent(tx, context, { type: 'surveillance.notified', aggregateType: 'patient', aggregateId: row.patientId, data: { caseId: row.id, diseaseCode: row.diseaseCode, immediate: row.immediate } });
}

export async function listCases(context, { status, since, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrSurveillanceCase.findMany({
      where: { organizationId: context.organizationId, ...(status ? { status: { in: status } } : {}), ...(since ? { reportedAt: { gte: new Date(since) } } : {}) },
      include: { patient: patientSummary }, orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }], take: limit,
    });
    await recordAudit(tx, context, { action: 'surveillance.listed', resourceType: 'surveillance_case' });
    return { items: await present(tx, rows), diseases: DISEASES };
  });
}

export async function notifyCase(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'surveillance.notify', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (input.onsetDate && new Date(`${input.onsetDate}T00:00:00.000Z`).getTime() > Date.now()) throw new EmrError('VALIDATION_FAILED', { message: 'The date of onset cannot be in the future.' });
    const d = disease(input.diseaseCode);
    const row = await tx.emrSurveillanceCase.create({
      data: {
        organizationId: context.organizationId, patientId: patient.id, diseaseCode: d.code, diseaseName: d.name, immediate: d.immediate,
        onsetDate: input.onsetDate ? new Date(`${input.onsetDate}T00:00:00.000Z`) : null, notes: input.notes ?? null, reportedByUserId: context.userId,
      },
    });
    await notified(tx, context, row);
    return { statusCode: 201, body: await fullCase(tx, context, row.id) };
  }));
}

/** Opens a suspected AEFI case inside the caller's transaction; returns its id. */
export async function openCaseFromAefi(tx, context, { patientId, vaccineName, symptoms }) {
  const d = disease('AEFI');
  const row = await tx.emrSurveillanceCase.create({
    data: {
      organizationId: context.organizationId, patientId, diseaseCode: d.code, diseaseName: d.name, immediate: true, source: 'AEFI',
      onsetDate: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`), notes: `Serious AEFI after ${vaccineName}: ${symptoms}`.slice(0, 1000), reportedByUserId: context.userId,
    },
  });
  await notified(tx, context, row);
  return row.id;
}

export async function classifyCase(context, caseId, expectedVersion, { status, note }) {
  return withTenant(context, async (tx) => {
    const row = await tx.emrSurveillanceCase.findFirst({ where: { organizationId: context.organizationId, id: caseId } });
    if (!row) throw new EmrError('SURVEILLANCE_CASE_NOT_FOUND');
    if (row.status !== 'SUSPECTED') throw new EmrError('INVALID_STATE', { message: 'This case has already been classified.' });
    await updateVersioned(tx.emrSurveillanceCase, {
      organizationId: context.organizationId, id: caseId, expectedVersion, notFoundCode: 'SURVEILLANCE_CASE_NOT_FOUND',
      data: { status, classifiedByUserId: context.userId, classifiedAt: new Date(), classificationNote: note ?? null },
    });
    await recordAudit(tx, context, { action: `surveillance.${status.toLowerCase()}`, resourceType: 'surveillance_case', resourceId: caseId });
    await enqueueEvent(tx, context, { type: 'surveillance.classified', aggregateType: 'patient', aggregateId: row.patientId, data: { caseId, status } });
    return fullCase(tx, context, caseId);
  });
}
