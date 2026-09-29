// Patient registry use cases. Each runs in ONE tenant transaction that also writes the audit row
// and (for changes) the outbox event, so a change, its audit trail and its webhook either all
// commit or none do.
import prisma from '../../../config/db.js';
import { withTenant } from '../core/db.js';
import { recordAudit, changedFieldNames } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { nextSequence } from '../core/sequence.js';
import { afterCursor } from '../core/cursor.js';
import { enqueueEvent } from '../core/outbox.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import * as repo from './patients.repository.js';

const UNIQUE = {
  hospital_number: 'HOSPITAL_NUMBER_IN_USE',
  hospitalNumber: 'HOSPITAL_NUMBER_IN_USE',
  medical_record_number: 'MEDICAL_RECORD_NUMBER_IN_USE',
  medicalRecordNumber: 'MEDICAL_RECORD_NUMBER_IN_USE',
  national_id: 'NATIONAL_ID_IN_USE',
  nationalId: 'NATIONAL_ID_IN_USE',
  linked_user_id: 'PATIENT_ALREADY_LINKED',
  linkedUserId: 'PATIENT_ALREADY_LINKED',
};
const mapped = async (promise) => {
  try { return await promise; } catch (error) { throw uniqueViolation(error, UNIQUE) ?? error; }
};

const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
export const toPatient = (row) => ({ ...row, dateOfBirth: dateOnly(row.dateOfBirth) });
const toDbFields = (input) => ({ ...input, ...(input.dateOfBirth ? { dateOfBirth: new Date(`${input.dateOfBirth}T00:00:00.000Z`) } : {}) });

/**
 * Next free MRN for the tenant (MRN-0000001, …) from the per-tenant counter, which serialises
 * concurrent registrations. A number already taken by a hand-entered MRN is skipped.
 */
async function issueMrn(tx, context) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const mrn = `MRN-${String(await nextSequence(tx, context, 'mrn')).padStart(7, '0')}`;
    const taken = await tx.emrPatient.findFirst({ where: { organizationId: context.organizationId, medicalRecordNumber: mrn }, select: { id: true } });
    if (!taken) return mrn;
  }
  throw new Error('Could not find a free MRN after 100 attempts');
}

export async function registerPatient(context, input, { idempotencyKey } = {}) {
  return mapped(withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'patient.register', body: input }, async () => {
    const medicalRecordNumber = input.medicalRecordNumber ?? await issueMrn(tx, context);
    const row = await repo.createPatient(tx, { ...toDbFields(input), medicalRecordNumber, organizationId: context.organizationId, createdByUserId: context.userId });
    await recordAudit(tx, context, { action: 'patient.registered', resourceType: 'patient', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'patient.registered', aggregateType: 'patient', aggregateId: row.id });
    return { statusCode: 201, body: toPatient(row) };
  })));
}

export async function listPatients(context, query) {
  const after = afterCursor('createdAt', query.cursor);
  return withTenant(context, async (tx) => {
    const result = query.page
      ? await repo.listPatientsPage(tx, context.organizationId, query)
      : await repo.listPatients(tx, context.organizationId, { ...query, after });
    // HIPAA access log: record that the registry was read/searched (never the search text).
    await recordAudit(tx, context, { action: query.q ? 'patient.searched' : 'patient.listed', resourceType: 'patient' });
    return { ...result, items: result.items.map(toPatient) };
  });
}

export async function getPatient(context, patientId) {
  return withTenant(context, async (tx) => {
    const row = await repo.findPatient(tx, context.organizationId, patientId);
    if (!row) throw new EmrError('PATIENT_NOT_FOUND');
    await recordAudit(tx, context, { action: 'patient.viewed', resourceType: 'patient', resourceId: row.id });
    return toPatient(row);
  });
}

async function versionedChange(context, patientId, expectedVersion, { action, requireStatus, build }) {
  return mapped(withTenant(context, async (tx) => {
    const current = await repo.findPatient(tx, context.organizationId, patientId);
    if (!current) throw new EmrError('PATIENT_NOT_FOUND');
    if (requireStatus && current.status !== requireStatus) {
      throw new EmrError(requireStatus === 'ACTIVE' ? 'PATIENT_INACTIVE' : 'INVALID_STATE');
    }
    const data = build(current);
    const changedFields = changedFieldNames(current, data);
    const row = await repo.updatePatient(tx, { organizationId: context.organizationId, id: patientId, expectedVersion, data: { ...data, updatedByUserId: context.userId } });
    await recordAudit(tx, context, { action, resourceType: 'patient', resourceId: patientId, changedFields });
    await enqueueEvent(tx, context, { type: action, aggregateType: 'patient', aggregateId: patientId, data: { changedFields, version: row.version } });
    return toPatient(row);
  }));
}

export const updatePatient = (context, patientId, expectedVersion, changes) =>
  versionedChange(context, patientId, expectedVersion, { action: 'patient.updated', requireStatus: 'ACTIVE', build: () => toDbFields(changes) });

export const deactivatePatient = (context, patientId, expectedVersion, { reason }) =>
  versionedChange(context, patientId, expectedVersion, {
    action: 'patient.deactivated', requireStatus: 'ACTIVE',
    build: () => ({ status: 'INACTIVE', deactivatedAt: new Date(), deactivationReason: reason }),
  });

export const reactivatePatient = (context, patientId, expectedVersion) =>
  versionedChange(context, patientId, expectedVersion, {
    action: 'patient.reactivated', requireStatus: 'INACTIVE',
    build: () => ({ status: 'ACTIVE', deactivatedAt: null, deactivationReason: null }),
  });

/**
 * Links an EMR record to a Sabi (telemedicine) patient account. The account must have an ACTIVE
 * enrollment with this hospital — the patient's own consent to be known here — so staff cannot
 * attach a stranger's account by guessing a user id.
 * The enrollment lives outside the EMR tables, so it is read before the tenant transaction.
 */
export async function linkPatientAccount(context, patientId, expectedVersion, { userId }) {
  const enrollment = context.facilityId ? await prisma.hospitalEnrollment.findFirst({
    where: { patientId: userId, hospitalId: context.facilityId, status: 'ACTIVE', dependentId: null },
    select: { id: true },
  }) : null;
  if (!enrollment) throw new EmrError('INVALID_STATE', { message: 'That account has no active enrollment with this organization.' });
  return versionedChange(context, patientId, expectedVersion, {
    action: 'patient.account_linked', requireStatus: 'ACTIVE',
    build: (current) => {
      if (current.linkedUserId && current.linkedUserId !== userId) throw new EmrError('PATIENT_ALREADY_LINKED', { message: 'This record is already linked to a different account.' });
      return { linkedUserId: userId };
    },
  });
}

export async function findDuplicates(context, query) {
  return withTenant(context, async (tx) => {
    const rows = await repo.findDuplicates(tx, context.organizationId, query);
    await recordAudit(tx, context, { action: 'patient.duplicate_check', resourceType: 'patient' });
    return rows.map(toPatient);
  });
}
