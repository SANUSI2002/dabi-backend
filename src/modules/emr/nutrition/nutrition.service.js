// Child health (growth monitoring for under-fives) and nutrition (CMAM). The server classifies and
// picks the programme (see the migration header); a MAM/SAM growth visit enrols the child in CMAM in
// the same transaction unless the child is already in the caseload. Discharge records a WHO Sphere
// outcome once.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { markEnteredInError } from '../core/entries.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';

const toDate = (iso) => new Date(`${iso}T00:00:00.000Z`);
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const num = (value) => (value === null || value === undefined ? null : Number(value));
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const withPatient = (p) => (p ? { ...p, dateOfBirth: isoDay(p.dateOfBirth) } : undefined);
const FIVE_YEARS_MS = 5 * 365.25 * 86_400_000;

/** MUAC (cm) and oedema → NORMAL / MAM / SAM (CMAM Nigeria). */
export const classify = (muac, oedema = 'NONE') => (oedema !== 'NONE' || muac < 11.5 ? 'SAM' : muac < 12.5 ? 'MAM' : 'NORMAL');
/** SAM with a failed appetite test or severe oedema is treated in the Stabilisation Centre. */
export const programmeFor = (classification, appetite = 'PASS', oedema = 'NONE') =>
  classification === 'SAM' ? (appetite === 'FAIL' || oedema === 'SEVERE' ? 'SC' : 'OTP') : classification === 'MAM' ? 'SFP' : null;

async function requireChild(tx, context, patientId, on) {
  const patient = await findPatient(tx, context.organizationId, patientId, { id: true, status: true, dateOfBirth: true });
  if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
  if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
  if (on.getTime() > Date.now()) throw new EmrError('VALIDATION_FAILED', { message: 'The date cannot be in the future.' });
  if (on < patient.dateOfBirth) throw new EmrError('VALIDATION_FAILED', { message: 'The date is before the child was born.' });
  if (on.getTime() - patient.dateOfBirth.getTime() >= FIVE_YEARS_MS) throw new EmrError('VALIDATION_FAILED', { message: 'Growth monitoring and CMAM are for children under five.' });
  return patient;
}

async function names(tx, ids) {
  const map = await userNameMap(tx, ids);
  return (id) => (id ? map.get(id) ?? null : null);
}
const screeningView = (s, name) => ({
  id: s.id, patientId: s.patientId, patient: withPatient(s.patient), version: s.version, screeningDate: isoDay(s.screeningDate), muacCm: num(s.muacCm),
  oedema: s.oedema, appetite: s.appetite, growthMonitoringDone: s.growthMonitoringDone, notes: s.notes, classification: s.classification, programme: s.programme,
  source: s.source, growthVisitId: s.growthVisitId, outcome: s.outcome, dischargedAt: s.dischargedAt, dischargedByName: name(s.dischargedByUserId), recordedByName: name(s.recordedByUserId),
});
const visitView = (v, name, cmam) => ({
  id: v.id, patientId: v.patientId, patient: withPatient(v.patient), visitDate: isoDay(v.visitDate), weightKg: num(v.weightKg), heightCm: num(v.heightCm),
  muacCm: num(v.muacCm), waz: num(v.waz), feeding: v.feeding, classification: v.classification, status: v.status, recordedByName: name(v.recordedByUserId),
  enrolledInCmam: cmam,
});

export async function listGrowthVisits(context, { patientId, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrGrowthVisit.findMany({
      where: { organizationId: context.organizationId, ...(patientId ? { patientId } : {}) },
      include: { patient: patientSummary, cmamScreenings: { select: { id: true } } }, orderBy: [{ visitDate: 'desc' }, { id: 'desc' }], take: limit,
    });
    await recordAudit(tx, context, { action: 'growth.listed', resourceType: 'growth_visit' });
    const name = await names(tx, rows.map((v) => v.recordedByUserId));
    return { items: rows.map((v) => visitView(v, name, v.cmamScreenings.length > 0)) };
  });
}

export async function listScreenings(context, { patientId, open, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrCmamScreening.findMany({
      where: { organizationId: context.organizationId, ...(patientId ? { patientId } : {}), ...(open ? { classification: { not: 'NORMAL' }, outcome: null } : {}) },
      include: { patient: patientSummary }, orderBy: [{ screeningDate: 'desc' }, { id: 'desc' }], take: limit,
    });
    await recordAudit(tx, context, { action: 'cmam.listed', resourceType: 'cmam_screening' });
    const name = await names(tx, rows.flatMap((s) => [s.recordedByUserId, s.dischargedByUserId]));
    return { items: rows.map((s) => screeningView(s, name)) };
  });
}

async function createScreening(tx, context, data) {
  try {
    return await tx.emrCmamScreening.create({ data: { organizationId: context.organizationId, recordedByUserId: context.userId, ...data } });
  } catch (error) {
    throw uniqueViolation(error, { one_open: 'CHILD_ALREADY_IN_CMAM' }) ?? error;
  }
}

export async function recordGrowthVisit(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'growth.record', body: input }, async () => {
    const visitDate = toDate(input.visitDate);
    const child = await requireChild(tx, context, input.patientId, visitDate);
    const classification = classify(input.muacCm);
    const visit = await tx.emrGrowthVisit.create({
      data: {
        organizationId: context.organizationId, patientId: child.id, visitDate, weightKg: input.weightKg, heightCm: input.heightCm, muacCm: input.muacCm,
        waz: input.waz ?? null, feeding: input.feeding, classification, recordedByUserId: context.userId,
      },
    });
    // A malnourished child joins the CMAM caseload, unless already in it.
    let enrolled = false;
    if (classification !== 'NORMAL') {
      const open = await tx.emrCmamScreening.findFirst({ where: { organizationId: context.organizationId, patientId: child.id, classification: { not: 'NORMAL' }, outcome: null }, select: { id: true } });
      if (!open) {
        await createScreening(tx, context, {
          patientId: child.id, screeningDate: visitDate, muacCm: input.muacCm, oedema: 'NONE', appetite: 'PASS', growthMonitoringDone: true,
          classification, programme: programmeFor(classification), source: 'CHILD_HEALTH', growthVisitId: visit.id,
        });
        enrolled = true;
      }
    }
    await recordAudit(tx, context, { action: 'growth.recorded', resourceType: 'growth_visit', resourceId: visit.id });
    await enqueueEvent(tx, context, { type: 'growth.recorded', aggregateType: 'patient', aggregateId: child.id, data: { visitId: visit.id, classification, enrolledInCmam: enrolled } });
    const name = await names(tx, [context.userId]);
    return { statusCode: 201, body: visitView({ ...visit, patient: await tx.emrPatient.findFirst({ where: { organizationId: context.organizationId, id: child.id }, ...patientSummary }) }, name, enrolled) };
  }));
}

export async function recordScreening(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'cmam.screen', body: input }, async () => {
    const screeningDate = toDate(input.screeningDate);
    const child = await requireChild(tx, context, input.patientId, screeningDate);
    const classification = classify(input.muacCm, input.oedema);
    const row = await createScreening(tx, context, {
      patientId: child.id, screeningDate, muacCm: input.muacCm, oedema: input.oedema, appetite: input.appetite, growthMonitoringDone: input.growthMonitoringDone ?? null,
      notes: input.notes ?? null, classification, programme: programmeFor(classification, input.appetite, input.oedema), source: 'NUTRITION',
    });
    await recordAudit(tx, context, { action: 'cmam.screened', resourceType: 'cmam_screening', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'cmam.screened', aggregateType: 'patient', aggregateId: child.id, data: { screeningId: row.id, classification, programme: row.programme } });
    const full = await tx.emrCmamScreening.findFirst({ where: { organizationId: context.organizationId, id: row.id }, include: { patient: patientSummary } });
    return { statusCode: 201, body: screeningView(full, await names(tx, [context.userId])) };
  }));
}

export async function discharge(context, screeningId, expectedVersion, { outcome }) {
  return withTenant(context, async (tx) => {
    const row = await tx.emrCmamScreening.findFirst({ where: { organizationId: context.organizationId, id: screeningId } });
    if (!row) throw new EmrError('CMAM_SCREENING_NOT_FOUND');
    if (row.classification === 'NORMAL') throw new EmrError('INVALID_STATE', { message: 'This child was not enrolled in CMAM.' });
    if (row.outcome) throw new EmrError('INVALID_STATE', { message: 'This child has already been discharged.' });
    await updateVersioned(tx.emrCmamScreening, {
      organizationId: context.organizationId, id: row.id, expectedVersion, notFoundCode: 'CMAM_SCREENING_NOT_FOUND',
      data: { outcome, dischargedAt: new Date(), dischargedByUserId: context.userId },
    });
    await recordAudit(tx, context, { action: 'cmam.discharged', resourceType: 'cmam_screening', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'cmam.discharged', aggregateType: 'patient', aggregateId: row.patientId, data: { screeningId: row.id, outcome } });
    const full = await tx.emrCmamScreening.findFirst({ where: { organizationId: context.organizationId, id: row.id }, include: { patient: patientSummary } });
    return screeningView(full, await names(tx, [full.recordedByUserId, full.dischargedByUserId]));
  });
}

export async function markGrowthEnteredInError(context, visitId, { reason }) {
  return withTenant(context, async (tx) => {
    const row = await markEnteredInError(tx.emrGrowthVisit, {
      where: { organizationId: context.organizationId, id: visitId }, userId: context.userId, reason, notFoundCode: 'GROWTH_VISIT_NOT_FOUND', label: 'visit',
    });
    await recordAudit(tx, context, { action: 'growth.entered_in_error', resourceType: 'growth_visit', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'growth.entered_in_error', aggregateType: 'patient', aggregateId: row.patientId, data: { visitId: row.id } });
    return { id: row.id, status: 'ENTERED_IN_ERROR' };
  });
}
