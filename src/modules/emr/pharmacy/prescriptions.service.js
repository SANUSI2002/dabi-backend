// Prescribing and pharmacist review.
//
//   prescribe (doctor, open visit) ──► PENDING_REVIEW ──approve──► APPROVED ──dispense──► …
//                                        └──reject──► REJECTED            (see dispensing.service)
//   cancel (prescriber side) from PENDING_REVIEW / APPROVED / PARTIALLY_DISPENSED
//
// Safety checks run on the server at prescribing time (allergy incl. drug class, maximum dose,
// duplicate therapy). HIGH alerts block unless the prescriber sends an override reason; the
// alerts and overrides are stored on each line for the pharmacist and the audit trail.
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError } from '../core/errors.js';
import { requireOpen } from '../encounters/encounters.policy.js';
import * as policy from './pharmacy.policy.js';
import { ensureFormulary, inDateTotal, pharmacyPatient, toItem, toPrescription, todayUtc } from './pharmacy.shared.js';

const ITEM_ORDER = { orderBy: { createdAt: 'asc' } };

/** The patient's current medicines (other prescriptions), with drug classes for class checks. */
async function currentItems(tx, context, patientId) {
  const since = new Date(Date.now() - 366 * 86_400_000);
  const items = await tx.emrPrescriptionItem.findMany({
    where: {
      organizationId: context.organizationId, status: { not: 'CANCELLED' }, createdAt: { gte: since },
      prescription: { patientId, status: { in: policy.CURRENT_PRESCRIPTION_STATUSES } },
    },
  });
  const current = items.filter((item) => policy.isCurrent(item));
  if (!current.length) return [];
  const drugs = await tx.emrFormularyItem.findMany({
    where: { organizationId: context.organizationId, id: { in: [...new Set(current.map((i) => i.formularyItemId))] } },
    select: { id: true, drugClasses: true },
  });
  return current.map((item) => ({ ...item, drugClasses: drugs.find((d) => d.id === item.formularyItemId)?.drugClasses ?? [] }));
}

export async function prescribe(context, encounterId, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: `prescription:${encounterId}`, body: input }, async () => {
    const encounter = await tx.emrEncounter.findFirst({
      where: { organizationId: context.organizationId, id: encounterId },
      select: { id: true, status: true, patientId: true, patient: { select: { status: true } } },
    });
    if (!encounter) throw new EmrError('ENCOUNTER_NOT_FOUND');
    requireOpen(encounter);
    if (encounter.patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');

    await ensureFormulary(tx, context);
    const codes = input.items.map((line) => line.drugCode);
    const drugs = await tx.emrFormularyItem.findMany({ where: { organizationId: context.organizationId, code: { in: codes }, active: true } });
    const unknown = codes.filter((code) => !drugs.some((d) => d.code === code));
    if (unknown.length) throw new EmrError('VALIDATION_FAILED', { message: `Not in the active formulary: ${unknown.join(', ')}.` });

    const lines = input.items.map((line) => policy.prepareLine(line, drugs.find((d) => d.code === line.drugCode)));
    const allergies = await tx.emrPatientAllergy.findMany({ where: { organizationId: context.organizationId, patientId: encounter.patientId, status: 'ACTIVE' } });
    const alerts = policy.applyOverrides(
      policy.safetyAlerts({ lines, drugs, allergies, activeItems: await currentItems(tx, context, encounter.patientId) }),
      input.overrides,
    );

    const prescription = await tx.emrPrescription.create({
      data: {
        organizationId: context.organizationId, encounterId, patientId: encounter.patientId, notes: input.notes, prescriberUserId: context.userId,
        items: { create: lines.map((line) => ({ ...line, safetyAlerts: alerts.filter((a) => a.drugCode === line.drugCode) })) },
      },
      include: { items: ITEM_ORDER },
    });
    const overridden = alerts.filter((a) => a.overrideReason).map((a) => `${a.drugCode}:${a.type}`);
    await recordAudit(tx, context, { action: 'prescription.created', resourceType: 'prescription', resourceId: prescription.id, changedFields: overridden.length ? ['safetyOverride', ...overridden] : [] });
    await enqueueEvent(tx, context, {
      type: 'prescription.created', aggregateType: 'prescription', aggregateId: prescription.id,
      data: { encounterId, patientId: encounter.patientId, items: lines.length, controlled: lines.some((l) => l.controlled), overrides: overridden.length },
    });
    return { statusCode: 201, body: toPrescription(prescription) };
  }));
}

export async function listEncounterPrescriptions(context, encounterId) {
  return withTenant(context, async (tx) => {
    const encounter = await tx.emrEncounter.findFirst({ where: { organizationId: context.organizationId, id: encounterId }, select: { id: true } });
    if (!encounter) throw new EmrError('ENCOUNTER_NOT_FOUND');
    const rows = await tx.emrPrescription.findMany({ where: { organizationId: context.organizationId, encounterId }, include: { items: ITEM_ORDER }, orderBy: { createdAt: 'asc' } });
    await recordAudit(tx, context, { action: 'prescription.viewed', resourceType: 'encounter', resourceId: encounterId });
    return rows.map(toPrescription);
  });
}

/** Everything the pharmacist needs: minimal identity, active allergies, lines, stock, dispenses. */
export async function getPrescription(context, prescriptionId) {
  return withTenant(context, async (tx) => {
    const prescription = await tx.emrPrescription.findFirst({
      where: { organizationId: context.organizationId, id: prescriptionId },
      include: { items: ITEM_ORDER, patient: pharmacyPatient, dispenses: { include: { lines: true }, orderBy: { dispensedAt: 'asc' } } },
    });
    if (!prescription) throw new EmrError('PRESCRIPTION_NOT_FOUND');
    // Sequential on purpose: a transaction runs on one connection.
    const allergies = await tx.emrPatientAllergy.findMany({
      where: { organizationId: context.organizationId, patientId: prescription.patientId, status: 'ACTIVE' },
      select: { id: true, substance: true, substanceCode: true, reaction: true, severity: true },
    });
    const batches = await tx.emrStockBatch.findMany({
      where: { organizationId: context.organizationId, formularyItemId: { in: prescription.items.map((i) => i.formularyItemId) } },
      select: { id: true, formularyItemId: true, batchNumber: true, expiryDate: true, quantityOnHand: true },
    });
    const today = todayUtc();
    await recordAudit(tx, context, { action: 'prescription.viewed', resourceType: 'prescription', resourceId: prescriptionId });
    const batchNumber = new Map(batches.map((b) => [b.id, b.batchNumber]));
    return {
      ...toPrescription(prescription),
      allergies,
      items: prescription.items.map((item) => ({ ...toItem(item), inStock: inDateTotal(batches, item.formularyItemId, today) })),
      dispenses: prescription.dispenses.map((d) => ({ ...d, lines: d.lines.map((l) => ({ ...l, batchNumber: batchNumber.get(l.batchId) })) })),
    };
  });
}

/** Pharmacy queue, oldest first. Flags lines with overridden safety alerts for extra attention. */
export async function queue(context, { status, patientId, limit, cursor }) {
  const after = afterCursor('createdAt', cursor, 'asc');
  return withTenant(context, async (tx) => {
    const rows = await tx.emrPrescription.findMany({
      where: {
        organizationId: context.organizationId,
        status: { in: status ?? ['PENDING_REVIEW', 'APPROVED', 'PARTIALLY_DISPENSED'] },
        ...(patientId ? { patientId } : {}),
        ...after,
      },
      include: { patient: pharmacyPatient, items: ITEM_ORDER },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'pharmacy_queue.viewed', resourceType: 'prescription' });
    const result = page(rows, limit, 'createdAt');
    return {
      ...result,
      items: result.items.map((row) => ({
        ...toPrescription(row),
        overriddenAlerts: row.items.flatMap((i) => i.safetyAlerts).filter((a) => a.overrideReason).length,
        controlled: row.items.some((i) => i.controlled),
      })),
    };
  });
}

async function loadPrescription(tx, context, prescriptionId) {
  const prescription = await tx.emrPrescription.findFirst({ where: { organizationId: context.organizationId, id: prescriptionId }, include: { items: ITEM_ORDER } });
  if (!prescription) throw new EmrError('PRESCRIPTION_NOT_FOUND');
  return prescription;
}

const updatePrescription = (tx, context, id, expectedVersion, data) =>
  updateVersioned(tx.emrPrescription, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'PRESCRIPTION_NOT_FOUND' });

export async function review(context, prescriptionId, expectedVersion, decision, { note, reason }) {
  return withTenant(context, async (tx) => {
    const prescription = await loadPrescription(tx, context, prescriptionId);
    policy.requirePrescriptionStatus(prescription, ['PENDING_REVIEW'], decision === 'approve' ? 'approved' : 'rejected');
    const now = new Date();
    const data = decision === 'approve'
      ? { status: 'APPROVED', reviewedAt: now, reviewedByUserId: context.userId, reviewNote: note ?? null }
      : { status: 'REJECTED', reviewedAt: now, reviewedByUserId: context.userId, rejectionReason: reason };
    await updatePrescription(tx, context, prescriptionId, expectedVersion, data);
    if (decision === 'reject') {
      await tx.emrPrescriptionItem.updateMany({ where: { organizationId: context.organizationId, prescriptionId, status: 'ACTIVE' }, data: { status: 'CANCELLED', version: { increment: 1 } } });
    }
    const type = decision === 'approve' ? 'prescription.approved' : 'prescription.rejected';
    await recordAudit(tx, context, { action: type, resourceType: 'prescription', resourceId: prescriptionId });
    await enqueueEvent(tx, context, { type, aggregateType: 'prescription', aggregateId: prescriptionId, data: { patientId: prescription.patientId, encounterId: prescription.encounterId } });
    return toPrescription(await loadPrescription(tx, context, prescriptionId));
  });
}

/** Prescriber-side stop. What was already dispensed stays on record; the rest is cancelled. */
export async function cancel(context, encounterId, prescriptionId, expectedVersion, { reason }) {
  return withTenant(context, async (tx) => {
    const prescription = await loadPrescription(tx, context, prescriptionId);
    if (prescription.encounterId !== encounterId) throw new EmrError('PRESCRIPTION_NOT_FOUND');
    policy.requirePrescriptionStatus(prescription, policy.CANCELLABLE, 'cancelled');
    await updatePrescription(tx, context, prescriptionId, expectedVersion, { status: 'CANCELLED', cancelledAt: new Date(), cancelledByUserId: context.userId, cancellationReason: reason });
    await tx.emrPrescriptionItem.updateMany({ where: { organizationId: context.organizationId, prescriptionId, status: 'ACTIVE' }, data: { status: 'CANCELLED', version: { increment: 1 } } });
    await recordAudit(tx, context, { action: 'prescription.cancelled', resourceType: 'prescription', resourceId: prescriptionId });
    await enqueueEvent(tx, context, { type: 'prescription.cancelled', aggregateType: 'prescription', aggregateId: prescriptionId, data: { patientId: prescription.patientId, encounterId } });
    return toPrescription(await loadPrescription(tx, context, prescriptionId));
  });
}

/** The patient's medication list across visits: current by default, or the full history. */
export async function patientMedications(context, patientId, { scope }) {
  return withTenant(context, async (tx) => {
    const patient = await tx.emrPatient.findFirst({ where: { organizationId: context.organizationId, id: patientId }, select: { id: true } });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    const rows = await tx.emrPrescriptionItem.findMany({
      where: { organizationId: context.organizationId, prescription: { patientId, ...(scope === 'all' ? {} : { status: { in: policy.CURRENT_PRESCRIPTION_STATUSES } }) } },
      include: { prescription: { select: { id: true, encounterId: true, status: true, prescriberUserId: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const items = (scope === 'all' ? rows : rows.filter((item) => policy.isCurrent(item)))
      .map((item) => ({ ...toItem(item), courseEndsAt: new Date(policy.courseEnd(item)).toISOString() }));
    await recordAudit(tx, context, { action: 'medication_list.viewed', resourceType: 'patient', resourceId: patientId });
    return items;
  });
}
