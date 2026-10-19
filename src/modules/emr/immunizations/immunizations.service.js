// Immunization: routine EPI doses per child (each antigen once, never before its minimum age),
// AEFI reports (one per dose), and the defaulter list (under-fives 4+ weeks past a dose they have
// not had here). A serious AEFI also opens a suspected case in Surveillance, in the same transaction.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { markEnteredInError } from '../core/entries.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';
import { ageInWeeks, missedDoses, vaccine } from './immunizations.policy.js';
import { openCaseFromAefi } from '../surveillance/surveillance.service.js';

const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const withPatient = (p) => (p ? { ...p, dateOfBirth: isoDay(p.dateOfBirth) } : undefined);
const FIVE_YEARS_MS = 5 * 365.25 * 86_400_000;

async function present(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((d) => [d.givenByUserId, d.erroredByUserId, d.aefi?.reportedByUserId]));
  const name = (id) => (id ? names.get(id) ?? null : null);
  return rows.map((d) => ({
    id: d.id, patientId: d.patientId, patient: withPatient(d.patient), vaccineCode: d.vaccineCode, vaccineName: d.vaccineName, givenAt: d.givenAt,
    batchNumber: d.batchNumber, site: d.site, givenByName: name(d.givenByUserId), status: d.status, errorReason: d.errorReason, erroredByName: name(d.erroredByUserId),
    aefi: d.aefi ? { id: d.aefi.id, symptoms: d.aefi.symptoms, severity: d.aefi.severity, onsetHours: d.aefi.onsetHours, actionTaken: d.aefi.actionTaken, reportedAt: d.aefi.reportedAt, reportedByName: name(d.aefi.reportedByUserId), surveillanceCaseId: d.aefi.surveillanceCaseId ?? null } : null,
  }));
}
const include = { patient: patientSummary, aefi: true };
const fullDose = async (tx, context, id) => (await present(tx, [await tx.emrImmunization.findFirst({ where: { organizationId: context.organizationId, id }, include })]))[0];

export async function listDoses(context, { patientId, aefiOnly, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrImmunization.findMany({
      where: { organizationId: context.organizationId, ...(patientId ? { patientId } : {}), ...(aefiOnly ? { aefi: { isNot: null } } : {}) },
      include, orderBy: [{ givenAt: 'desc' }, { id: 'desc' }], take: limit,
    });
    await recordAudit(tx, context, { action: 'immunization.listed', resourceType: 'immunization' });
    return { items: await present(tx, rows) };
  });
}

/** Under-fives who are 4+ weeks past a dose they have not had here. */
export async function defaulters(context, now = new Date()) {
  return withTenant(context, async (tx) => {
    const children = await tx.emrPatient.findMany({
      where: { organizationId: context.organizationId, status: 'ACTIVE', dateOfBirth: { gte: new Date(now.getTime() - FIVE_YEARS_MS) } },
      select: patientSummary.select, take: 5000,
    });
    const doses = children.length ? await tx.emrImmunization.findMany({
      where: { organizationId: context.organizationId, status: 'ACTIVE', patientId: { in: children.map((c) => c.id) } }, select: { patientId: true, vaccineCode: true },
    }) : [];
    await recordAudit(tx, context, { action: 'immunization.defaulters_listed', resourceType: 'immunization' });
    return {
      items: children.flatMap((child) => {
        const given = new Set(doses.filter((d) => d.patientId === child.id).map((d) => d.vaccineCode));
        const missed = missedDoses(child.dateOfBirth, given, now);
        return missed.length ? [{ patientId: child.id, patient: withPatient(child), ageWeeks: ageInWeeks(child.dateOfBirth, now), missed }] : [];
      }),
    };
  });
}

export async function giveDose(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'immunization.give', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true, dateOfBirth: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
    const v = vaccine(input.vaccineCode);
    const givenAt = input.givenAt ? new Date(input.givenAt) : new Date();
    if (givenAt.getTime() > Date.now() + 5 * 60_000) throw new EmrError('VALIDATION_FAILED', { message: 'The dose time cannot be in the future.' });
    if (givenAt < patient.dateOfBirth) throw new EmrError('VALIDATION_FAILED', { message: 'The dose time is before the child was born.' });
    const age = ageInWeeks(patient.dateOfBirth, givenAt);
    if (age < v.ageWeeks) throw new EmrError('VALIDATION_FAILED', { message: `${v.name} is given from ${v.ageWeeks} weeks of age; this child was ${age} weeks old.` });
    let row;
    try {
      row = await tx.emrImmunization.create({
        data: {
          organizationId: context.organizationId, patientId: patient.id, vaccineCode: v.code, vaccineName: v.name, givenAt,
          batchNumber: input.batchNumber, site: input.site, givenByUserId: context.userId,
        },
      });
    } catch (error) {
      throw uniqueViolation(error, { one_dose: 'DOSE_ALREADY_GIVEN' }) ?? error;
    }
    await recordAudit(tx, context, { action: 'immunization.given', resourceType: 'immunization', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'immunization.given', aggregateType: 'patient', aggregateId: patient.id, data: { immunizationId: row.id, vaccineCode: v.code } });
    return { statusCode: 201, body: await fullDose(tx, context, row.id) };
  }));
}

export async function reportAefi(context, immunizationId, input) {
  return withTenant(context, async (tx) => {
    const dose = await tx.emrImmunization.findFirst({ where: { organizationId: context.organizationId, id: immunizationId } });
    if (!dose) throw new EmrError('IMMUNIZATION_NOT_FOUND');
    if (dose.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: 'This dose was entered in error.' });
    let report;
    try {
      report = await tx.emrAefiReport.create({
        data: {
          organizationId: context.organizationId, immunizationId: dose.id, patientId: dose.patientId, symptoms: input.symptoms, severity: input.severity,
          onsetHours: input.onsetHours, actionTaken: input.actionTaken, reportedByUserId: context.userId,
        },
      });
    } catch (error) {
      throw uniqueViolation(error, { immunization: 'AEFI_ALREADY_REPORTED' }) ?? error;
    }
    if (input.severity === 'SERIOUS') {
      const caseId = await openCaseFromAefi(tx, context, { patientId: dose.patientId, vaccineName: dose.vaccineName, symptoms: input.symptoms });
      await tx.emrAefiReport.updateMany({ where: { organizationId: context.organizationId, id: report.id }, data: { surveillanceCaseId: caseId } });
    }
    await recordAudit(tx, context, { action: 'immunization.aefi_reported', resourceType: 'immunization', resourceId: dose.id });
    await enqueueEvent(tx, context, { type: 'immunization.aefi_reported', aggregateType: 'patient', aggregateId: dose.patientId, data: { immunizationId: dose.id, severity: input.severity } });
    return fullDose(tx, context, dose.id);
  });
}

export async function markDoseEnteredInError(context, immunizationId, { reason }) {
  return withTenant(context, async (tx) => {
    const reported = await tx.emrAefiReport.findFirst({ where: { organizationId: context.organizationId, immunizationId }, select: { id: true } });
    if (reported) throw new EmrError('INVALID_STATE', { message: 'An AEFI is reported against this dose, so it stays on the record.' });
    const row = await markEnteredInError(tx.emrImmunization, {
      where: { organizationId: context.organizationId, id: immunizationId }, userId: context.userId, reason, notFoundCode: 'IMMUNIZATION_NOT_FOUND', label: 'dose',
    });
    await recordAudit(tx, context, { action: 'immunization.entered_in_error', resourceType: 'immunization', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'immunization.entered_in_error', aggregateType: 'patient', aggregateId: row.patientId, data: { immunizationId: row.id } });
    return fullDose(tx, context, row.id);
  });
}
