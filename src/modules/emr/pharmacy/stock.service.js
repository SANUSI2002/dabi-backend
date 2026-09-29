// Formulary and pharmacy stock: receipts, adjustments, the movement ledger and reconciliation.
// Stock quantities only ever change through moveStock(), which writes the ledger row in the same
// transaction — so the ledger always explains the balance (see reconciliation()).
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit, changedFieldNames } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { etagFor, updateVersioned } from '../core/concurrency.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { toDateString } from './pharmacy.policy.js';
import { ensureFormulary, inDateTotal, lockBatches, moveStock, signalLowStock, toBatch, toFormulary, todayUtc } from './pharmacy.shared.js';

// ---------------------------------------------------------------------------------------------
// Formulary
// ---------------------------------------------------------------------------------------------
export async function listFormulary(context, { includeInactive, q }) {
  return withTenant(context, async (tx) => {
    await ensureFormulary(tx, context);
    const items = await tx.emrFormularyItem.findMany({
      where: {
        organizationId: context.organizationId,
        ...(includeInactive === 'true' ? {} : { active: true }),
        ...(q ? { OR: [{ code: { startsWith: q.toUpperCase() } }, { genericName: { contains: q, mode: 'insensitive' } }, { brandName: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { genericName: 'asc' },
    });
    const stock = await tx.emrStockBatch.groupBy({
      by: ['formularyItemId'],
      where: { organizationId: context.organizationId, expiryDate: { gt: new Date(`${todayUtc()}T00:00:00.000Z`) } },
      _sum: { quantityOnHand: true },
    });
    const onHand = new Map(stock.map((s) => [s.formularyItemId, s._sum.quantityOnHand ?? 0]));
    return items.map((item) => ({ ...toFormulary(item), inStock: onHand.get(item.id) ?? 0 }));
  });
}

export async function createFormularyItem(context, input) {
  try {
    return await withTenant(context, async (tx) => {
      await ensureFormulary(tx, context);
      const item = await tx.emrFormularyItem.create({ data: { ...input, organizationId: context.organizationId } });
      await recordAudit(tx, context, { action: 'formulary.created', resourceType: 'formulary_item', resourceId: item.id });
      return toFormulary(item);
    });
  } catch (error) {
    throw uniqueViolation(error, { code: 'FORMULARY_CODE_IN_USE' }) ?? error;
  }
}

export async function updateFormularyItem(context, code, expectedVersion, changes) {
  return withTenant(context, async (tx) => {
    await ensureFormulary(tx, context);
    const current = await tx.emrFormularyItem.findFirst({ where: { organizationId: context.organizationId, code } });
    if (!current) throw new EmrError('FORMULARY_ITEM_NOT_FOUND');
    const item = await updateVersioned(tx.emrFormularyItem, { organizationId: context.organizationId, id: current.id, expectedVersion, data: changes, notFoundCode: 'FORMULARY_ITEM_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'formulary.updated', resourceType: 'formulary_item', resourceId: item.id, changedFields: changedFieldNames(toFormulary(current), changes) });
    return toFormulary(item);
  });
}

async function drugByCode(tx, context, code) {
  await ensureFormulary(tx, context);
  const drug = await tx.emrFormularyItem.findFirst({ where: { organizationId: context.organizationId, code } });
  if (!drug) throw new EmrError('FORMULARY_ITEM_NOT_FOUND');
  return drug;
}

// ---------------------------------------------------------------------------------------------
// Receipts and adjustments
// ---------------------------------------------------------------------------------------------
/** Receives stock into a batch (created, or topped up when the same batch/expiry arrives again). */
export async function receiveStock(context, input, { idempotencyKey }) {
  if (!idempotencyKey) throw new EmrError('IDEMPOTENCY_KEY_REQUIRED');
  if (input.expiryDate <= todayUtc()) throw new EmrError('VALIDATION_FAILED', { message: 'Expired or same-day-expiry stock cannot be received.' });
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'stock.receipt', body: input }, async () => {
    const drug = await drugByCode(tx, context, input.formularyCode);
    if (!drug.active) throw new EmrError('INVALID_STATE', { message: `${drug.genericName} is not active in the formulary.` });
    // Create the batch row at zero if new; the quantity arrives through the ledger below.
    await tx.$executeRaw`
      INSERT INTO "emr_stock_batches" ("id", "organization_id", "formulary_item_id", "batch_number", "expiry_date", "unit_cost_minor", "supplier", "updated_at")
      VALUES (gen_random_uuid()::text, ${context.organizationId}, ${drug.id}, ${input.batchNumber}, ${input.expiryDate}::date, ${input.unitCostMinor ?? null}, ${input.supplier ?? null}, now())
      ON CONFLICT ("organization_id", "formulary_item_id", "batch_number", "expiry_date") DO NOTHING`;
    const [batch] = (await lockBatches(tx, context, [drug.id])).filter((b) => b.batchNumber === input.batchNumber && toDateString(b.expiryDate) === input.expiryDate);
    await moveStock(tx, context, { batch, kind: 'RECEIPT', quantity: input.quantity, reason: input.supplier ? `Received from ${input.supplier}` : 'Received' });
    await recordAudit(tx, context, { action: 'stock.received', resourceType: 'stock_batch', resourceId: batch.id });
    const row = await tx.emrStockBatch.findFirst({ where: { organizationId: context.organizationId, id: batch.id } });
    return { statusCode: 201, body: { ...toBatch(row), formularyCode: drug.code } };
  }));
}

/** Signed correction to one batch (stock count, damage, expiry write-off…). Never below zero. */
export async function adjustStock(context, batchId, expectedVersion, { quantity, reason, note }) {
  return withTenant(context, async (tx) => {
    const found = await tx.emrStockBatch.findFirst({ where: { organizationId: context.organizationId, id: batchId }, include: { formularyItem: true } });
    if (!found) throw new EmrError('BATCH_NOT_FOUND');
    const drug = found.formularyItem;
    const batches = await lockBatches(tx, context, [drug.id]);
    // Version is checked only once the row is locked, so nothing can change in between.
    const { version } = await tx.emrStockBatch.findFirst({ where: { organizationId: context.organizationId, id: batchId }, select: { version: true } });
    if (version !== expectedVersion) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: version }, headers: { ETag: etagFor(version) } });
    const batch = batches.find((b) => b.id === batchId);
    const before = inDateTotal(batches, drug.id, todayUtc());
    await moveStock(tx, context, { batch, kind: 'ADJUSTMENT', quantity, reason: note ? `${reason}: ${note}` : reason });
    const after = inDateTotal(batches, drug.id, todayUtc());
    await recordAudit(tx, context, { action: 'stock.adjusted', resourceType: 'stock_batch', resourceId: batchId, changedFields: ['quantityOnHand'] });
    await signalLowStock(tx, context, { drug, before, after });
    const row = await tx.emrStockBatch.findFirst({ where: { organizationId: context.organizationId, id: batchId } });
    return toBatch(row);
  });
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------
export async function stockLevels(context, { q, lowOnly, expiringWithinDays }) {
  return withTenant(context, async (tx) => {
    await ensureFormulary(tx, context);
    const today = todayUtc();
    const soon = expiringWithinDays ? new Date(Date.now() + expiringWithinDays * 86_400_000).toISOString().slice(0, 10) : null;
    const drugs = await tx.emrFormularyItem.findMany({
      where: { organizationId: context.organizationId, active: true, ...(q ? { OR: [{ code: { startsWith: q.toUpperCase() } }, { genericName: { contains: q, mode: 'insensitive' } }] } : {}) },
      include: { batches: { where: { quantityOnHand: { gt: 0 } }, orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }] } },
      orderBy: { genericName: 'asc' },
    });
    const rows = drugs.map((drug) => {
      const batches = drug.batches.map(toBatch);
      const inDate = batches.filter((b) => b.expiryDate > today);
      const onHand = inDate.reduce((sum, b) => sum + b.quantityOnHand, 0);
      return {
        formularyItemId: drug.id, code: drug.code, genericName: drug.genericName, strength: drug.strength, dispenseUnit: drug.dispenseUnit,
        reorderLevel: drug.reorderLevel, onHand, lowStock: onHand <= drug.reorderLevel,
        expiredOnHand: batches.filter((b) => b.expiryDate <= today).reduce((sum, b) => sum + b.quantityOnHand, 0),
        expiringSoon: soon ? inDate.filter((b) => b.expiryDate <= soon).reduce((sum, b) => sum + b.quantityOnHand, 0) : undefined,
        nextExpiry: inDate[0]?.expiryDate ?? null,
        batches,
      };
    });
    return rows.filter((r) => (lowOnly === 'true' ? r.lowStock : true) && (soon ? r.expiringSoon > 0 || r.expiredOnHand > 0 : true));
  });
}

export async function movements(context, { formularyCode, batchId, cursor, limit }) {
  const after = afterCursor('createdAt', cursor, 'desc');
  return withTenant(context, async (tx) => {
    const drug = formularyCode ? await drugByCode(tx, context, formularyCode) : null;
    const rows = await tx.emrStockMovement.findMany({
      where: {
        organizationId: context.organizationId,
        ...(drug ? { formularyItemId: drug.id } : {}),
        ...(batchId ? { batchId } : {}),
        ...after,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return page(rows, limit, 'createdAt');
  });
}

/**
 * Proves the ledger explains every balance: on-hand must equal the sum of its movements. Checks
 * one page of batches (in id order) per call — `nextCursor` continues — so the work per request
 * stays bounded however large the pharmacy is.
 */
export async function reconciliation(context, { cursor = null, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT b."id" AS "batchId", b."batch_number" AS "batchNumber", b."quantity_on_hand" AS "onHand",
             COALESCE(SUM(m."quantity"), 0)::int AS "ledger"
      FROM "emr_stock_batches" b
      LEFT JOIN "emr_stock_movements" m ON m."organization_id" = b."organization_id" AND m."batch_id" = b."id"
      WHERE b."organization_id" = ${context.organizationId} AND (${cursor}::text IS NULL OR b."id" > ${cursor})
      GROUP BY b."id", b."batch_number", b."quantity_on_hand"
      ORDER BY b."id"
      LIMIT ${limit + 1}`;
    const checked = rows.slice(0, limit);
    const discrepancies = checked.filter((r) => Number(r.onHand) !== Number(r.ledger)).map((r) => ({ ...r, onHand: Number(r.onHand), ledger: Number(r.ledger) }));
    return { batchesChecked: checked.length, balanced: discrepancies.length === 0, discrepancies, nextCursor: rows.length > limit ? checked[limit - 1].batchId : null };
  });
}
