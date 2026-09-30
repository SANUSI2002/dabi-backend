// Dispensing and returns — the only code that moves stock out of (or back into) the pharmacy.
//
// Guarantees (see docs/emr-backend.md, "Prescriptions and dispensing"):
//   * no double dispense on retry: an Idempotency-Key is mandatory and is claimed in the same
//     transaction as the stock movement;
//   * no overselling: the prescription row and every batch of the drugs involved are locked
//     (FOR UPDATE) before quantities are read; the database also refuses negative stock;
//   * no deadlocks between dispenses sharing drugs: batches are always locked in one order
//     (drug, expiry, id) by a single statement (lockBatches);
//   * FEFO: earliest in-date expiry first; expired stock is never dispensed;
//   * controlled medicines need a witness who is a different, active pharmacy member.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { EmrError } from '../core/errors.js';
import { activeMemberWithPermission } from '../core/membership.js';
import { updateVersioned } from '../core/concurrency.js';
import * as policy from './pharmacy.policy.js';
import { inDateTotal, lockBatches, moveStock, signalLowStock, toItem, todayUtc } from './pharmacy.shared.js';

async function lockPrescription(tx, context, prescriptionId) {
  const locked = await tx.$queryRaw`
    SELECT "id" FROM "emr_prescriptions" WHERE "organization_id" = ${context.organizationId} AND "id" = ${prescriptionId} FOR UPDATE`;
  if (!locked.length) throw new EmrError('PRESCRIPTION_NOT_FOUND');
  return tx.emrPrescription.findFirst({ where: { organizationId: context.organizationId, id: prescriptionId }, include: { items: { orderBy: { createdAt: 'asc' } } } });
}

async function requireWitness(context, witnessUserId) {
  if (!witnessUserId) return;
  if (witnessUserId === context.userId) throw new EmrError('WITNESS_REQUIRED', { message: 'The witness must be a different person from the dispenser.' });
  if (!await activeMemberWithPermission(context.organizationId, witnessUserId, 'prescription.dispense')) {
    throw new EmrError('WITNESS_REQUIRED', { message: 'The witness must be an active pharmacy staff member of this organization.' });
  }
}

/** Writes item quantities/statuses and the prescription status after a dispense or return. */
async function settle(tx, context, prescription, itemChanges) {
  const items = prescription.items.map((item) => {
    const delta = itemChanges.get(item.id) ?? 0;
    return delta ? { ...item, quantityDispensed: item.quantityDispensed + delta } : item;
  });
  for (const item of items) {
    const delta = itemChanges.get(item.id);
    if (!delta) continue;
    const { count } = await tx.emrPrescriptionItem.updateMany({
      where: { organizationId: context.organizationId, id: item.id, version: item.version },
      data: { quantityDispensed: item.quantityDispensed, status: policy.itemStatusFor(item), version: { increment: 1 } },
    });
    if (count !== 1) throw new Error('Prescription item changed while its prescription was locked');
  }
  const status = prescription.status === 'CANCELLED' ? 'CANCELLED' : policy.prescriptionStatusFor(items.map((i) => ({ ...i, status: policy.itemStatusFor(i) })));
  await tx.emrPrescription.updateMany({ where: { organizationId: context.organizationId, id: prescription.id }, data: { status, version: { increment: 1 } } });
  return status;
}

export async function dispense(context, prescriptionId, input, { idempotencyKey }) {
  if (!idempotencyKey) throw new EmrError('IDEMPOTENCY_KEY_REQUIRED');
  await requireWitness(context, input.witnessUserId);
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: `dispense:${prescriptionId}`, body: input }, async () => {
    const prescription = await lockPrescription(tx, context, prescriptionId);
    policy.requirePrescriptionStatus(prescription, policy.DISPENSABLE, 'dispensed');

    const requested = input.lines.map((line) => {
      const item = prescription.items.find((i) => i.id === line.itemId);
      if (!item) throw new EmrError('PRESCRIPTION_ITEM_NOT_FOUND');
      if (item.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: `${item.drugName} is ${item.status.toLowerCase()} and cannot be dispensed.` });
      const remaining = item.quantityPrescribed - item.quantityDispensed;
      if (line.quantity > remaining) throw new EmrError('VALIDATION_FAILED', { message: `Only ${remaining} ${item.dispenseUnit}(s) of ${item.drugName} remain to dispense.` });
      return { item, quantity: line.quantity };
    });
    if (requested.some((r) => r.item.controlled) && !input.witnessUserId) throw new EmrError('WITNESS_REQUIRED');

    const drugIds = [...new Set(requested.map((r) => r.item.formularyItemId))];
    const batches = await lockBatches(tx, context, drugIds);
    const today = todayUtc();
    const before = new Map(drugIds.map((id) => [id, inDateTotal(batches, id, today)]));
    // Allocate everything first: the dispense is all-or-nothing.
    const allocations = requested.map((r) => ({
      ...r,
      picks: policy.allocateFefo(batches.filter((b) => b.formularyItemId === r.item.formularyItemId), r.quantity, today, r.item.drugCode),
    }));

    const record = await tx.emrDispense.create({
      data: { organizationId: context.organizationId, prescriptionId, dispensedByUserId: context.userId, witnessUserId: input.witnessUserId ?? null, note: input.note ?? null },
    });
    const lines = [];
    for (const { item, picks } of allocations) {
      for (const { batch, quantity } of picks) {
        await moveStock(tx, context, { batch, kind: 'DISPENSE', quantity: -quantity, dispenseId: record.id });
        lines.push(await tx.emrDispenseLine.create({ data: { organizationId: context.organizationId, dispenseId: record.id, prescriptionItemId: item.id, batchId: batch.id, quantity } }));
      }
    }
    const status = await settle(tx, context, prescription, new Map(requested.map((r) => [r.item.id, r.quantity])));

    const drugs = await tx.emrFormularyItem.findMany({ where: { organizationId: context.organizationId, id: { in: drugIds } } });
    for (const drug of drugs) await signalLowStock(tx, context, { drug, before: before.get(drug.id), after: inDateTotal(batches, drug.id, today) });
    await recordAudit(tx, context, { action: 'medication.dispensed', resourceType: 'prescription', resourceId: prescriptionId, changedFields: requested.map((r) => r.item.drugCode) });
    await enqueueEvent(tx, context, {
      type: 'medication.dispensed', aggregateType: 'prescription', aggregateId: prescriptionId,
      data: { dispenseId: record.id, patientId: prescription.patientId, status, controlled: requested.some((r) => r.item.controlled) },
    });

    const batchInfo = new Map(batches.map((b) => [b.id, { batchNumber: b.batchNumber, expiryDate: policy.toDateString(b.expiryDate) }]));
    const items = await tx.emrPrescriptionItem.findMany({ where: { organizationId: context.organizationId, prescriptionId }, orderBy: { createdAt: 'asc' } });
    return {
      statusCode: 201,
      body: { ...record, prescriptionStatus: status, lines: lines.map((l) => ({ ...l, ...batchInfo.get(l.batchId) })), items: items.map(toItem) },
    };
  }));
}

/**
 * The pharmacy closes a line it will not dispense: sent out to be bought elsewhere (OUTSOURCED) or
 * not dispensed (NOT_DISPENSED), with the reason. What was already handed over stays on record.
 * Takes the prescription's version (If-Match); the prescription status follows its lines.
 */
export async function closeItem(context, prescriptionId, itemId, expectedVersion, { outcome, reason }) {
  return withTenant(context, async (tx) => {
    const prescription = await lockPrescription(tx, context, prescriptionId);
    policy.requirePrescriptionStatus(prescription, policy.DISPENSABLE, 'closed at the pharmacy');
    const item = prescription.items.find((i) => i.id === itemId);
    if (!item) throw new EmrError('PRESCRIPTION_ITEM_NOT_FOUND');
    if (item.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: `${item.drugName} is ${item.status.toLowerCase()}; there is nothing left to close.` });
    const now = new Date();
    const { count } = await tx.emrPrescriptionItem.updateMany({
      where: { organizationId: context.organizationId, id: itemId, version: item.version },
      data: { status: 'CANCELLED', closeOutcome: outcome, closeReason: reason, closedByUserId: context.userId, closedAt: now, version: { increment: 1 } },
    });
    if (count !== 1) throw new Error('Prescription item changed while its prescription was locked');
    const items = prescription.items.map((i) => (i.id === itemId ? { ...i, status: 'CANCELLED' } : i));
    const status = policy.prescriptionStatusFor(items);
    await updateVersioned(tx.emrPrescription, {
      organizationId: context.organizationId, id: prescriptionId, expectedVersion, notFoundCode: 'PRESCRIPTION_NOT_FOUND',
      data: { status, ...(status === 'CANCELLED' ? { cancelledAt: now, cancelledByUserId: context.userId, cancellationReason: `Not dispensed at the pharmacy: ${reason}` } : {}) },
    });
    await recordAudit(tx, context, { action: 'prescription.item_closed', resourceType: 'prescription_item', resourceId: itemId, changedFields: [outcome] });
    await enqueueEvent(tx, context, { type: 'prescription.item_closed', aggregateType: 'prescription', aggregateId: prescriptionId, data: { patientId: prescription.patientId, itemId, outcome, status } });
    const fresh = await tx.emrPrescription.findFirst({ where: { organizationId: context.organizationId, id: prescriptionId }, include: { items: { orderBy: { createdAt: 'asc' } } } });
    return { ...fresh, items: fresh.items.map(toItem) };
  });
}

/**
 * Patient returns medicine. Stock goes back to the same batch (RETURN). When it cannot be reused
 * (restock: false) it is written off straight away (ADJUSTMENT), so the ledger shows both steps.
 */
export async function returnDispense(context, dispenseId, input, { idempotencyKey }) {
  if (!idempotencyKey) throw new EmrError('IDEMPOTENCY_KEY_REQUIRED');
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: `dispense-return:${dispenseId}`, body: input }, async () => {
    const found = await tx.emrDispense.findFirst({ where: { organizationId: context.organizationId, id: dispenseId }, select: { prescriptionId: true } });
    if (!found) throw new EmrError('DISPENSE_NOT_FOUND');
    const prescription = await lockPrescription(tx, context, found.prescriptionId);
    const dispenseLines = await tx.emrDispenseLine.findMany({ where: { organizationId: context.organizationId, dispenseId } });

    const returns = input.lines.map((line) => {
      const dispensed = dispenseLines.find((l) => l.id === line.lineId);
      if (!dispensed) throw new EmrError('VALIDATION_FAILED', { message: 'A returned line is not part of this dispense.' });
      const left = dispensed.quantity - dispensed.quantityReturned;
      if (line.quantity > left) throw new EmrError('VALIDATION_FAILED', { message: `Only ${left} of that line can still be returned.` });
      return { dispensed, quantity: line.quantity };
    });

    const items = new Map(prescription.items.map((i) => [i.id, i]));
    const batches = await lockBatches(tx, context, [...new Set(returns.map((r) => items.get(r.dispensed.prescriptionItemId).formularyItemId))]);
    const changes = new Map();
    for (const { dispensed, quantity } of returns) {
      const batch = batches.find((b) => b.id === dispensed.batchId);
      await moveStock(tx, context, { batch, kind: 'RETURN', quantity, reason: input.reason, dispenseId });
      if (!input.restock) await moveStock(tx, context, { batch, kind: 'ADJUSTMENT', quantity: -quantity, reason: `Returned, not restockable: ${input.reason}` });
      const { count } = await tx.emrDispenseLine.updateMany({
        where: { organizationId: context.organizationId, id: dispensed.id, quantityReturned: dispensed.quantityReturned },
        data: { quantityReturned: dispensed.quantityReturned + quantity },
      });
      if (count !== 1) throw new Error('Dispense line changed while its prescription was locked');
      changes.set(dispensed.prescriptionItemId, (changes.get(dispensed.prescriptionItemId) ?? 0) - quantity);
    }
    const status = await settle(tx, context, prescription, changes);
    await recordAudit(tx, context, { action: 'medication.returned', resourceType: 'dispense', resourceId: dispenseId });
    await enqueueEvent(tx, context, { type: 'medication.returned', aggregateType: 'prescription', aggregateId: prescription.id, data: { dispenseId, patientId: prescription.patientId, restocked: input.restock } });
    const lines = await tx.emrDispenseLine.findMany({ where: { organizationId: context.organizationId, dispenseId } });
    return { statusCode: 201, body: { dispenseId, prescriptionStatus: status, restocked: input.restock, lines } };
  }));
}
