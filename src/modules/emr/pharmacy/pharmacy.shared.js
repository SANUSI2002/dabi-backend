// Shared helpers for the pharmacy services: serializers, stock locks and low-stock signalling.
import { enqueueEvent } from '../core/outbox.js';
import { EmrError } from '../core/errors.js';
import { toDateString } from './pharmacy.policy.js';
import { DEFAULT_FORMULARY } from './formulary.catalog.js';

const num = (value) => (value === null || value === undefined ? null : Number(value));
export const todayUtc = () => new Date().toISOString().slice(0, 10);
const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

export const toFormulary = (row) => ({ ...row, dosePerDispenseUnit: num(row.dosePerDispenseUnit), maxDailyDose: num(row.maxDailyDose) });
export const toBatch = (row) => ({ ...row, expiryDate: toDateString(row.expiryDate) });
export const toItem = (row) => ({ ...row, dose: num(row.dose) });
export const toPatientSummary = (patient) => (patient ? { ...patient, dateOfBirth: dateOnly(patient.dateOfBirth) } : patient);
export const toPrescription = (row) => ({
  ...row,
  ...(row.items ? { items: row.items.map(toItem) } : {}),
  ...(row.patient ? { patient: toPatientSummary(row.patient) } : {}),
});

// Minimum identity the pharmacy needs to label and hand over medicines.
export const pharmacyPatient = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };

/** UC-4 style lazy provisioning of the starter formulary. */
export async function ensureFormulary(tx, context) {
  if (await tx.emrFormularyItem.count({ where: { organizationId: context.organizationId } })) return;
  await tx.emrFormularyItem.createMany({
    data: DEFAULT_FORMULARY.map((item) => ({ ...item, organizationId: context.organizationId })),
    skipDuplicates: true,
  });
}

/**
 * Locks every batch of the given drugs, in one statement ordered by (drug, expiry, id). All stock
 * writers lock in this same order, so two dispenses sharing drugs queue instead of deadlocking.
 */
export async function lockBatches(tx, context, formularyItemIds) {
  if (!formularyItemIds.length) return [];
  const rows = await tx.$queryRaw`
    SELECT "id", "formulary_item_id" AS "formularyItemId", "batch_number" AS "batchNumber",
           "expiry_date" AS "expiryDate", "quantity_on_hand" AS "quantityOnHand"
    FROM "emr_stock_batches"
    WHERE "organization_id" = ${context.organizationId} AND "formulary_item_id" = ANY(${formularyItemIds}::text[])
    ORDER BY "formulary_item_id", "expiry_date", "id"
    FOR UPDATE`;
  return rows.map((r) => ({ ...r, quantityOnHand: Number(r.quantityOnHand) }));
}

export const inDateTotal = (batches, formularyItemId, today) => batches
  .filter((b) => b.formularyItemId === formularyItemId && toDateString(b.expiryDate) > today)
  .reduce((sum, b) => sum + b.quantityOnHand, 0);

/** Applies a signed change to a locked batch and writes the matching ledger row. */
export async function moveStock(tx, context, { batch, kind, quantity, reason = null, dispenseId = null }) {
  const balanceAfter = batch.quantityOnHand + quantity;
  if (balanceAfter < 0) throw new EmrError('INSUFFICIENT_STOCK', { message: `Batch ${batch.batchNumber} has only ${batch.quantityOnHand} on hand.` });
  const { count } = await tx.emrStockBatch.updateMany({
    where: { organizationId: context.organizationId, id: batch.id, quantityOnHand: batch.quantityOnHand },
    data: { quantityOnHand: balanceAfter, version: { increment: 1 } },
  });
  // The row is locked, so a mismatch means a caller skipped lockBatches — fail loudly.
  if (count !== 1) throw new Error('Stock batch changed while locked');
  await tx.emrStockMovement.create({
    data: { organizationId: context.organizationId, batchId: batch.id, formularyItemId: batch.formularyItemId, kind, quantity, balanceAfter, reason, dispenseId, userId: context.userId },
  });
  batch.quantityOnHand = balanceAfter;
  return balanceAfter;
}

/** Emits stock.low only when in-date stock crosses the reorder level (not on every movement). */
export async function signalLowStock(tx, context, { drug, before, after }) {
  if (drug.reorderLevel > 0 && before > drug.reorderLevel && after <= drug.reorderLevel) {
    await enqueueEvent(tx, context, { type: 'stock.low', aggregateType: 'formulary_item', aggregateId: drug.id, data: { code: drug.code, onHand: after, reorderLevel: drug.reorderLevel } });
  }
}
