// Patient allergies — the input to allergy checks at prescribing time. Entries are never edited;
// a wrong one is marked ENTERED_IN_ERROR and a correct one recorded.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { enqueueEvent } from '../core/outbox.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { markEnteredInError } from '../core/entries.js';

async function requirePatient(tx, context, patientId) {
  const patient = await tx.emrPatient.findFirst({ where: { organizationId: context.organizationId, id: patientId }, select: { id: true } });
  if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
}

export async function listAllergies(context, patientId, { includeErrors }) {
  return withTenant(context, async (tx) => {
    await requirePatient(tx, context, patientId);
    const rows = await tx.emrPatientAllergy.findMany({
      where: { organizationId: context.organizationId, patientId, ...(includeErrors === 'true' ? {} : { status: 'ACTIVE' }) },
      orderBy: { createdAt: 'asc' },
    });
    await recordAudit(tx, context, { action: 'allergy.viewed', resourceType: 'patient', resourceId: patientId });
    return rows;
  });
}

export async function recordAllergy(context, patientId, input) {
  try {
    return await withTenant(context, async (tx) => {
      await requirePatient(tx, context, patientId);
      const row = await tx.emrPatientAllergy.create({ data: { ...input, organizationId: context.organizationId, patientId, recordedByUserId: context.userId } });
      await recordAudit(tx, context, { action: 'allergy.recorded', resourceType: 'allergy', resourceId: row.id });
      await enqueueEvent(tx, context, { type: 'allergy.recorded', aggregateType: 'patient', aggregateId: patientId, data: { allergyId: row.id } });
      return row;
    });
  } catch (error) {
    throw uniqueViolation(error, { active_key: 'ALLERGY_ALREADY_RECORDED' }) ?? error;
  }
}

/** Confirms an unconfirmed or presumed allergy (who and when are kept); confirming twice changes nothing. */
export async function confirmAllergy(context, patientId, allergyId) {
  return withTenant(context, async (tx) => {
    await requirePatient(tx, context, patientId);
    const where = { organizationId: context.organizationId, patientId, id: allergyId, status: 'ACTIVE' };
    const row = await tx.emrPatientAllergy.findFirst({ where });
    if (!row) throw new EmrError('ALLERGY_NOT_FOUND');
    if (row.verificationStatus === 'CONFIRMED') return row;
    await tx.emrPatientAllergy.updateMany({
      where: { ...where, verificationStatus: { not: 'CONFIRMED' } },
      data: { verificationStatus: 'CONFIRMED', verifiedByUserId: context.userId, verifiedAt: new Date() },
    });
    await recordAudit(tx, context, { action: 'allergy.confirmed', resourceType: 'allergy', resourceId: allergyId });
    await enqueueEvent(tx, context, { type: 'allergy.confirmed', aggregateType: 'patient', aggregateId: patientId, data: { allergyId } });
    return tx.emrPatientAllergy.findFirst({ where });
  });
}

/** Marks an active allergy as entered in error (the record itself is never edited or deleted). */
export async function markAllergyError(context, patientId, allergyId, { reason }) {
  return withTenant(context, async (tx) => {
    await requirePatient(tx, context, patientId);
    const row = await markEnteredInError(tx.emrPatientAllergy, {
      where: { organizationId: context.organizationId, patientId, id: allergyId }, userId: context.userId, reason, notFoundCode: 'ALLERGY_NOT_FOUND', label: 'allergy',
    });
    await recordAudit(tx, context, { action: 'allergy.entered_in_error', resourceType: 'allergy', resourceId: allergyId });
    return row;
  });
}
