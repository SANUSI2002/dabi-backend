// Medication administration record (MAR) for admitted patients.
//
// Only pharmacist-approved, not-cancelled lines prescribed in the admission's own visit can be
// charted. A GIVEN dose passes the administration guard (dose/unit, minimum interval, daily count,
// one-off STAT, as-needed daily maximum). The prescription line is locked while checking, so two
// nurses charting the same medicine at once are serialized and the second sees the first's dose.
// Every chart entry needs an Idempotency-Key: a repeated tap must never chart a dose twice.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { activeMemberWithPermission } from '../core/membership.js';
import { EmrError } from '../core/errors.js';
import { markEnteredInError } from '../core/entries.js';
import * as policy from './admissions.policy.js';

const ADMINISTRABLE = ['APPROVED', 'PARTIALLY_DISPENSED', 'DISPENSED'];
const LATE_CHARTING_MS = 24 * 3_600_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const num = (value) => (value === null || value === undefined ? null : Number(value));
const toEntry = (row) => ({ ...row, dose: num(row.dose) });

async function loadAdmission(tx, context, admissionId) {
  const admission = await tx.emrAdmission.findFirst({ where: { organizationId: context.organizationId, id: admissionId } });
  if (!admission) throw new EmrError('ADMISSION_NOT_FOUND');
  return admission;
}

const activeGiven = (tx, context, itemId) => tx.emrMedicationAdministration.findMany({
  where: { organizationId: context.organizationId, prescriptionItemId: itemId, status: 'GIVEN', entryStatus: 'ACTIVE' },
  select: { administeredAt: true, dose: true },
  orderBy: { administeredAt: 'desc' },
});

/** The chart: what can be given (with last dose and next allowed time) and every entry made. */
export async function marView(context, admissionId) {
  return withTenant(context, async (tx) => {
    const admission = await loadAdmission(tx, context, admissionId);
    const items = await tx.emrPrescriptionItem.findMany({
      where: { organizationId: context.organizationId, status: { not: 'CANCELLED' }, prescription: { encounterId: admission.encounterId, status: { in: ADMINISTRABLE } } },
      orderBy: { createdAt: 'asc' },
    });
    const entries = await tx.emrMedicationAdministration.findMany({ where: { organizationId: context.organizationId, admissionId }, orderBy: { administeredAt: 'desc' } });
    const now = Date.now();
    const medicines = items.map((item) => {
      const given = entries.filter((e) => e.prescriptionItemId === item.id && e.status === 'GIVEN' && e.entryStatus === 'ACTIVE');
      const last = given[0]?.administeredAt ?? null;
      return {
        prescriptionItemId: item.id, drugCode: item.drugCode, drugName: item.drugName, strength: item.strength,
        dose: num(item.dose), doseUnit: item.doseUnit, frequency: item.frequency, route: item.route, prn: item.prn, controlled: item.controlled,
        instructions: item.instructions, lastGivenAt: last, nextAllowedAt: policy.nextAllowedAt(item, last),
        givenLast24h: given.filter((g) => g.administeredAt.getTime() > now - 24 * 3_600_000).reduce((sum, g) => sum + Number(g.dose), 0),
      };
    });
    await recordAudit(tx, context, { action: 'mar.viewed', resourceType: 'admission', resourceId: admissionId });
    return { admissionId, status: admission.status, medicines, entries: entries.map(toEntry) };
  });
}

export async function recordAdministration(context, admissionId, input, { idempotencyKey }) {
  if (!idempotencyKey) throw new EmrError('IDEMPOTENCY_KEY_REQUIRED');
  if (input.witnessUserId) {
    if (input.witnessUserId === context.userId) throw new EmrError('WITNESS_REQUIRED', { message: 'The witness must be a different person.' });
    if (!await activeMemberWithPermission(context.organizationId, input.witnessUserId, 'medication.administer')) {
      throw new EmrError('WITNESS_REQUIRED', { message: 'The witness must be an active clinical member of this organization.' });
    }
  }
  const at = input.administeredAt ? new Date(input.administeredAt) : new Date();
  if (at.getTime() > Date.now() + CLOCK_SKEW_MS) throw new EmrError('VALIDATION_FAILED', { message: 'A dose cannot be charted in the future.' });
  if (at.getTime() < Date.now() - LATE_CHARTING_MS) throw new EmrError('VALIDATION_FAILED', { message: 'Doses older than 24 hours cannot be charted here.' });

  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: `mar:${admissionId}`, body: input }, async () => {
    // FOR SHARE: many nurses may chart at once, but a discharge (FOR UPDATE) waits for them, and
    // a chart entry waits for an in-flight discharge — so nothing is charted on a closed stay.
    const admissionRow = await tx.$queryRaw`
      SELECT "id" FROM "emr_admissions" WHERE "organization_id" = ${context.organizationId} AND "id" = ${admissionId} FOR SHARE`;
    if (!admissionRow.length) throw new EmrError('ADMISSION_NOT_FOUND');
    const admission = await loadAdmission(tx, context, admissionId);
    policy.requireAdmitted(admission, 'charted');
    if (at < admission.admittedAt) throw new EmrError('VALIDATION_FAILED', { message: 'A dose cannot predate the admission.' });

    const locked = await tx.$queryRaw`
      SELECT "id" FROM "emr_prescription_items" WHERE "organization_id" = ${context.organizationId} AND "id" = ${input.prescriptionItemId} FOR UPDATE`;
    if (!locked.length) throw new EmrError('PRESCRIPTION_ITEM_NOT_FOUND');
    const item = await tx.emrPrescriptionItem.findFirst({
      where: { organizationId: context.organizationId, id: input.prescriptionItemId },
      include: { prescription: { select: { encounterId: true, patientId: true, status: true } } },
    });
    if (item.prescription.encounterId !== admission.encounterId || item.prescription.patientId !== admission.patientId) {
      throw new EmrError('VALIDATION_FAILED', { message: 'This medicine was not prescribed for this admission.' });
    }
    if (!ADMINISTRABLE.includes(item.prescription.status) || item.status === 'CANCELLED') {
      throw new EmrError('ADMINISTRATION_NOT_ALLOWED', { message: `${item.drugName} is not an approved, active prescription.`, details: { rule: 'NOT_ACTIVE' } });
    }

    let fields = { dose: null, doseUnit: null, route: null };
    if (input.status === 'GIVEN') {
      if (item.controlled && !input.witnessUserId) throw new EmrError('WITNESS_REQUIRED');
      const drug = await tx.emrFormularyItem.findFirst({ where: { organizationId: context.organizationId, id: item.formularyItemId }, select: { maxDailyDose: true } });
      const given = (await activeGiven(tx, context, item.id)).map((g) => ({ administeredAt: g.administeredAt, dose: Number(g.dose) }));
      policy.checkAdministration({ item, maxDailyDose: num(drug?.maxDailyDose), dose: input.dose, doseUnit: input.doseUnit, at, given });
      fields = { dose: input.dose, doseUnit: input.doseUnit, route: input.route ?? item.route };
    }
    const entry = await tx.emrMedicationAdministration.create({
      data: {
        organizationId: context.organizationId, admissionId, patientId: admission.patientId, prescriptionItemId: item.id, status: input.status,
        ...fields, administeredAt: at, administeredByUserId: context.userId, witnessUserId: input.witnessUserId ?? null, reason: input.reason ?? null,
      },
    });
    await recordAudit(tx, context, { action: `medication.${input.status.toLowerCase()}`, resourceType: 'medication_administration', resourceId: entry.id });
    await enqueueEvent(tx, context, { type: 'medication.administered', aggregateType: 'admission', aggregateId: admissionId, data: { patientId: admission.patientId, administrationId: entry.id, status: input.status } });
    return { statusCode: 201, body: toEntry(entry) };
  }));
}

export async function markAdministrationError(context, admissionId, administrationId, { reason }) {
  return withTenant(context, async (tx) => {
    await loadAdmission(tx, context, admissionId);
    const row = await markEnteredInError(tx.emrMedicationAdministration, {
      where: { organizationId: context.organizationId, admissionId, id: administrationId }, statusField: 'entryStatus',
      userId: context.userId, reason, notFoundCode: 'ADMINISTRATION_NOT_FOUND',
    });
    await recordAudit(tx, context, { action: 'medication.entered_in_error', resourceType: 'medication_administration', resourceId: administrationId });
    return toEntry(row);
  });
}
