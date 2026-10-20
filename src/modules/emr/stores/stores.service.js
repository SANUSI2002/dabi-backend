// Hospital stores. Stock lives in batches per storage location; the only writer of a batch's quantity
// is moveStock(), which also appends the movement — so on-hand always equals the sum of movements.
// Every stock-changing request first locks the item row (FOR UPDATE), which serialises concurrent
// changes to the same item. Issues, transfers and negative adjustments take First-Expiry-First-Out
// from usable batches (active, not expired); a quarantined batch is only touched when named for
// write-off. Requisitions move stock from a store to the requesting ward or department.
import { randomUUID } from 'node:crypto';
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { nextSequence } from '../core/sequence.js';
import { userNameMap } from '../core/people.js';

export const ITEM_CATEGORIES = ['Drugs', 'Consumables', 'Reagents', 'Other', 'PPE', 'Surgical Supplies', 'Linen', 'Medical Devices'];
// The usual stock-holding points of a hospital; each organization gets them on first use and can add more.
const STARTER_LOCATIONS = [
  ['MAIN', 'Main Store', 'STORE'], ['PHARM', 'Pharmacy Store', 'STORE'], ['LAB', 'Laboratory Store', 'STORE'],
  ['ER', 'Emergency', 'DEPARTMENT'], ['OT', 'Theatre', 'DEPARTMENT'], ['RAD', 'Radiology', 'DEPARTMENT'],
  ['ICU', 'ICU', 'WARD'], ['MEDW', 'Medical Ward', 'WARD'], ['MAT', 'Maternity', 'WARD'], ['PED', 'Pediatrics', 'WARD'],
];
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
const money = (minor) => Number(minor);
const usable = (batch, now = today()) => batch.status === 'ACTIVE' && batch.qtyRemaining > 0 && (!batch.expiryDate || batch.expiryDate >= now);
const fefo = (a, b) => {
  if (!a.expiryDate && !b.expiryDate) return a.receivedAt - b.receivedAt;
  if (!a.expiryDate) return 1;
  if (!b.expiryDate) return -1;
  return a.expiryDate - b.expiryDate || a.receivedAt - b.receivedAt;
};

async function ensureLocations(tx, context) {
  if (await tx.emrStoreLocation.count({ where: { organizationId: context.organizationId } })) return;
  await tx.emrStoreLocation.createMany({ data: STARTER_LOCATIONS.map(([code, name, type]) => ({ organizationId: context.organizationId, code, name, type })), skipDuplicates: true });
}

async function lockItem(tx, context, itemId) {
  const rows = await tx.$queryRaw`SELECT "id" FROM "emr_store_items" WHERE "organization_id" = ${context.organizationId} AND "id" = ${itemId} FOR UPDATE`;
  if (!rows.length) throw new EmrError('STORE_ITEM_NOT_FOUND');
  return tx.emrStoreItem.findFirst({ where: { organizationId: context.organizationId, id: itemId } });
}
async function activeLocation(tx, context, locationId, label = 'location') {
  const location = await tx.emrStoreLocation.findFirst({ where: { organizationId: context.organizationId, id: locationId } });
  if (!location) throw new EmrError('STORE_LOCATION_NOT_FOUND');
  if (location.status !== 'ACTIVE') throw new EmrError('VALIDATION_FAILED', { message: `The ${label} ${location.name} is inactive.` });
  return location;
}

/** The single writer of batch quantities: changes one batch and appends its movement. */
async function moveStock(tx, context, batch, qtyDelta, kind, extra = {}) {
  const { count } = await tx.emrStoreBatch.updateMany({
    where: { organizationId: context.organizationId, id: batch.id, qtyRemaining: batch.qtyRemaining },
    data: { qtyRemaining: batch.qtyRemaining + qtyDelta },
  });
  if (count !== 1) throw new EmrError('VERSION_CONFLICT', { message: 'The stock changed while this was being saved; try again.' });
  await tx.emrStoreMovement.create({
    data: {
      organizationId: context.organizationId, itemId: batch.itemId, batchId: batch.id, locationId: batch.locationId, kind, qtyDelta,
      unitCostMinor: batch.unitCostMinor, userId: context.userId, ...extra,
    },
  });
  batch.qtyRemaining += qtyDelta;
}

/** Takes `qty` from the item's usable batches at a location, earliest expiry first. Returns what was taken. */
async function consumeFefo(tx, context, item, locationId, qty, kind, extra) {
  const batches = (await tx.emrStoreBatch.findMany({ where: { organizationId: context.organizationId, itemId: item.id, locationId, qtyRemaining: { gt: 0 } } }))
    .filter((b) => usable(b)).sort(fefo);
  const available = batches.reduce((n, b) => n + b.qtyRemaining, 0);
  if (available < qty) throw new EmrError('INSUFFICIENT_STOCK', { message: `Only ${available} ${item.unit} of ${item.name} can be taken from this location.`, details: { available } });
  const taken = [];
  let left = qty;
  for (const batch of batches) {
    if (!left) break;
    const take = Math.min(left, batch.qtyRemaining);
    await moveStock(tx, context, batch, -take, kind, extra);
    taken.push({ batch, qty: take });
    left -= take;
  }
  return taken;
}

async function newBatch(tx, context, data) {
  return tx.emrStoreBatch.create({ data: { organizationId: context.organizationId, qtyRemaining: 0, ...data } });
}

// ---- reads ----------------------------------------------------------------------------------------
export async function overview(context, { movementLimit }) {
  return withTenant(context, async (tx) => {
    await ensureLocations(tx, context);
    const org = { organizationId: context.organizationId };
    const [locations, items, batches, movements, requisitions, counts, transfers] = await Promise.all([
      tx.emrStoreLocation.findMany({ where: org, orderBy: [{ type: 'asc' }, { name: 'asc' }] }),
      tx.emrStoreItem.findMany({ where: org, orderBy: { name: 'asc' } }),
      tx.emrStoreBatch.findMany({ where: { ...org, qtyRemaining: { gt: 0 } }, orderBy: { receivedAt: 'asc' } }),
      tx.emrStoreMovement.findMany({ where: org, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: movementLimit }),
      tx.emrStoreRequisition.findMany({ where: org, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 300 }),
      tx.emrStoreCount.findMany({ where: org, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 100 }),
      tx.emrStoreTransfer.findMany({ where: org, orderBy: { createdAt: 'desc' }, take: 300 }),
    ]);
    const names = await userNameMap(tx, [
      ...batches.map((b) => b.quarantinedByUserId), ...requisitions.flatMap((r) => [r.requestedByUserId, r.decidedByUserId]),
      ...counts.map((c) => c.createdByUserId), ...transfers.map((t) => t.userId), ...movements.map((m) => m.userId),
    ]);
    const name = (id) => (id ? names.get(id) ?? null : null);
    await recordAudit(tx, context, { action: 'stores.viewed', resourceType: 'store' });
    return {
      locations: locations.map((l) => ({ id: l.id, code: l.code, name: l.name, type: l.type, status: l.status, version: l.version })),
      items: items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, category: i.category, unit: i.unit, minLevel: i.minLevel, reorderLevel: i.reorderLevel, reorderQty: i.reorderQty, active: i.active, version: i.version })),
      batches: batches.map((b) => ({
        id: b.id, itemId: b.itemId, locationId: b.locationId, batchNumber: b.batchNumber, expiryDate: isoDay(b.expiryDate), qtyReceived: b.qtyReceived, qtyRemaining: b.qtyRemaining,
        unitCostMinor: money(b.unitCostMinor), status: b.status, quarantineReason: b.quarantineReason, quarantinedByName: name(b.quarantinedByUserId), quarantinedAt: b.quarantinedAt, receivedAt: b.receivedAt,
      })),
      movements: movements.map((m) => ({
        id: m.id, itemId: m.itemId, batchId: m.batchId, locationId: m.locationId, kind: m.kind, qtyDelta: m.qtyDelta, unitCostMinor: money(m.unitCostMinor),
        reference: m.reference, note: m.note, department: m.department, purpose: m.purpose, requisitionId: m.requisitionId, userName: name(m.userId), createdAt: m.createdAt,
      })),
      requisitions: requisitions.map((r) => ({
        id: r.id, number: r.number, requestingLocationId: r.requestingLocationId, fulfillingLocationId: r.fulfillingLocationId, neededBy: isoDay(r.neededBy), justification: r.justification,
        status: r.status, requestedByName: name(r.requestedByUserId), decidedByName: name(r.decidedByUserId), decidedAt: r.decidedAt, rejectionReason: r.rejectionReason, version: r.version, createdAt: r.createdAt,
        lines: r.lines.map((l) => ({ itemId: l.itemId, qtyRequested: l.qtyRequested, qtyIssued: l.qtyIssued })),
      })),
      counts: counts.map((c) => ({
        id: c.id, number: c.number, locationId: c.locationId, status: c.status, note: c.note, createdByName: name(c.createdByUserId), postedAt: c.postedAt, version: c.version, createdAt: c.createdAt,
        lines: c.lines.map((l) => ({ itemId: l.itemId, systemQty: l.systemQty, countedQty: l.countedQty })),
      })),
      transfers: transfers.map((t) => ({ id: t.id, itemId: t.itemId, qty: t.qty, valueMinor: money(t.valueMinor), fromLocationId: t.fromLocationId, toLocationId: t.toLocationId, reference: t.reference, requisitionId: t.requisitionId, userName: name(t.userId), createdAt: t.createdAt })),
    };
  });
}

// ---- items and locations --------------------------------------------------------------------------
export async function createItem(context, input) {
  return withTenant(context, async (tx) => {
    try {
      const item = await tx.emrStoreItem.create({ data: { organizationId: context.organizationId, ...input } });
      await recordAudit(tx, context, { action: 'store_item.created', resourceType: 'store_item', resourceId: item.id });
      return item;
    } catch (error) {
      throw uniqueViolation(error, { sku: 'STORE_SKU_IN_USE' }) ?? error;
    }
  });
}
export async function updateItem(context, itemId, expectedVersion, changes) {
  return withTenant(context, async (tx) => {
    const item = await updateVersioned(tx.emrStoreItem, { organizationId: context.organizationId, id: itemId, expectedVersion, data: { ...changes, updatedAt: new Date() }, notFoundCode: 'STORE_ITEM_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'store_item.updated', resourceType: 'store_item', resourceId: itemId, changedFields: Object.keys(changes) });
    return item;
  });
}
export async function createLocation(context, input) {
  return withTenant(context, async (tx) => {
    await ensureLocations(tx, context);
    try {
      const location = await tx.emrStoreLocation.create({ data: { organizationId: context.organizationId, ...input } });
      await recordAudit(tx, context, { action: 'store_location.created', resourceType: 'store_location', resourceId: location.id });
      return location;
    } catch (error) {
      throw uniqueViolation(error, { code: 'STORE_LOCATION_CODE_IN_USE' }) ?? error;
    }
  });
}
export async function setLocationStatus(context, locationId, expectedVersion, { status }) {
  return withTenant(context, async (tx) => {
    if (status === 'INACTIVE' && await tx.emrStoreBatch.count({ where: { organizationId: context.organizationId, locationId, qtyRemaining: { gt: 0 } } })) {
      throw new EmrError('INVALID_STATE', { message: 'Move or write off the stock held here before deactivating it.' });
    }
    const location = await updateVersioned(tx.emrStoreLocation, { organizationId: context.organizationId, id: locationId, expectedVersion, data: { status }, notFoundCode: 'STORE_LOCATION_NOT_FOUND' });
    await recordAudit(tx, context, { action: `store_location.${status.toLowerCase()}`, resourceType: 'store_location', resourceId: locationId });
    return location;
  });
}

// ---- stock movements ------------------------------------------------------------------------------
export async function receive(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'stores.receive', body: input }, async () => {
    const { batch } = await receiveInTx(tx, context, input);
    return { statusCode: 201, body: { batchId: batch.id, qty: input.qty } };
  }));
}
/** Receives a batch inside the caller's transaction (Accounting records a paid-for receipt with it). */
export async function receiveInTx(tx, context, input) {
  const item = await lockItem(tx, context, input.itemId);
  if (!item.active) throw new EmrError('VALIDATION_FAILED', { message: `${item.name} is inactive.` });
  await activeLocation(tx, context, input.locationId);
  if (input.expiryDate && new Date(`${input.expiryDate}T00:00:00.000Z`) < today()) throw new EmrError('VALIDATION_FAILED', { message: 'This batch has already expired; do not receive it into usable stock.' });
  const batch = await newBatch(tx, context, {
    itemId: item.id, locationId: input.locationId, batchNumber: input.batchNumber ?? null, expiryDate: input.expiryDate ? new Date(`${input.expiryDate}T00:00:00.000Z`) : null,
    qtyReceived: input.qty, unitCostMinor: BigInt(input.unitCostMinor), source: 'RECEIPT', reference: input.reference ?? null,
  });
  await moveStock(tx, context, batch, input.qty, 'RECEIPT', { reference: input.reference ?? null, note: input.note ?? null });
  await recordAudit(tx, context, { action: 'stores.received', resourceType: 'store_item', resourceId: item.id });
  return { item, batch };
}
/** The main store (created with the organization's first stores use). */
export async function mainLocationId(tx, context) {
  await ensureLocations(tx, context);
  const locations = await tx.emrStoreLocation.findMany({ where: { organizationId: context.organizationId, status: 'ACTIVE' } });
  return (locations.find((l) => l.code === 'MAIN') ?? locations.find((l) => l.type === 'STORE') ?? locations[0])?.id;
}

export async function issue(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'stores.issue', body: input }, async () => {
    const item = await lockItem(tx, context, input.itemId);
    await activeLocation(tx, context, input.locationId);
    const taken = await consumeFefo(tx, context, item, input.locationId, input.qty, 'ISSUE', { department: input.department ?? null, purpose: input.purpose ?? null, reference: input.reference ?? null });
    await recordAudit(tx, context, { action: 'stores.issued', resourceType: 'store_item', resourceId: item.id });
    return { statusCode: 201, body: { qty: input.qty, valueMinor: taken.reduce((n, t) => n + t.qty * Number(t.batch.unitCostMinor), 0) } };
  }));
}

/** Sets the item's quantity at a location to what is physically there (reason required). */
export async function adjust(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'stores.adjust', body: input }, async () => {
    const item = await lockItem(tx, context, input.itemId);
    await activeLocation(tx, context, input.locationId);
    const delta = await applyDelta(tx, context, item, input.locationId, input.qtyDelta, 'ADJUSTMENT', { note: input.reason });
    await recordAudit(tx, context, { action: 'stores.adjusted', resourceType: 'store_item', resourceId: item.id });
    return { statusCode: 201, body: { qtyDelta: delta } };
  }));
}

async function applyDelta(tx, context, item, locationId, qtyDelta, kind, extra) {
  if (qtyDelta < 0) {
    await consumeFefo(tx, context, item, locationId, -qtyDelta, kind, extra);
  } else if (qtyDelta > 0) {
    // Found stock is valued at the item's latest receipt cost (zero if never received).
    const last = await tx.emrStoreBatch.findFirst({ where: { organizationId: context.organizationId, itemId: item.id, source: 'RECEIPT' }, orderBy: { receivedAt: 'desc' } });
    const batch = await newBatch(tx, context, { itemId: item.id, locationId, qtyReceived: qtyDelta, unitCostMinor: last?.unitCostMinor ?? 0n, source: kind === 'COUNT' ? 'COUNT' : 'ADJUSTMENT' });
    await moveStock(tx, context, batch, qtyDelta, kind, extra);
  }
  return qtyDelta;
}

export async function writeOff(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'stores.write_off', body: input }, async () => {
    const item = await lockItem(tx, context, input.itemId);
    let value = 0;
    if (input.batchId) {
      // A named batch — usually quarantined or expired stock — is written off directly.
      const batch = await tx.emrStoreBatch.findFirst({ where: { organizationId: context.organizationId, id: input.batchId, itemId: item.id } });
      if (!batch) throw new EmrError('STORE_BATCH_NOT_FOUND');
      if (batch.qtyRemaining < input.qty) throw new EmrError('INSUFFICIENT_STOCK', { message: `This batch holds only ${batch.qtyRemaining} ${item.unit}.`, details: { available: batch.qtyRemaining } });
      value = input.qty * Number(batch.unitCostMinor);
      await moveStock(tx, context, batch, -input.qty, 'WRITE_OFF', { note: input.reason });
    } else {
      if (!input.locationId) throw new EmrError('VALIDATION_FAILED', { message: 'Choose the location or batch to write off from.' });
      // Expired stock goes first (it can no longer be used), then earliest expiry.
      const batches = (await tx.emrStoreBatch.findMany({ where: { organizationId: context.organizationId, itemId: item.id, locationId: input.locationId, qtyRemaining: { gt: 0 }, status: 'ACTIVE' } }))
        .sort((a, b) => Number(usable(a)) - Number(usable(b)) || fefo(a, b));
      const available = batches.reduce((n, b) => n + b.qtyRemaining, 0);
      if (available < input.qty) throw new EmrError('INSUFFICIENT_STOCK', { message: `Only ${available} ${item.unit} of ${item.name} is held at this location.`, details: { available } });
      let left = input.qty;
      for (const batch of batches) {
        if (!left) break;
        const take = Math.min(left, batch.qtyRemaining);
        value += take * Number(batch.unitCostMinor);
        await moveStock(tx, context, batch, -take, 'WRITE_OFF', { note: input.reason });
        left -= take;
      }
    }
    await recordAudit(tx, context, { action: 'stores.written_off', resourceType: 'store_item', resourceId: item.id });
    return { statusCode: 201, body: { qty: input.qty, valueMinor: value } };
  }));
}

// ---- quarantine -----------------------------------------------------------------------------------
export async function quarantine(context, batchId, { reason }) {
  return withTenant(context, async (tx) => {
    const batch = await tx.emrStoreBatch.findFirst({ where: { organizationId: context.organizationId, id: batchId } });
    if (!batch) throw new EmrError('STORE_BATCH_NOT_FOUND');
    await lockItem(tx, context, batch.itemId);
    const { count } = await tx.emrStoreBatch.updateMany({
      where: { organizationId: context.organizationId, id: batchId, status: 'ACTIVE', qtyRemaining: { gt: 0 } },
      data: { status: 'QUARANTINED', quarantineReason: reason, quarantinedByUserId: context.userId, quarantinedAt: new Date() },
    });
    if (count !== 1) throw new EmrError('INVALID_STATE', { message: 'Only a batch holding stock and not already quarantined can be quarantined.' });
    await recordAudit(tx, context, { action: 'stores.quarantined', resourceType: 'store_batch', resourceId: batchId });
    return { batchId, status: 'QUARANTINED' };
  });
}
export async function release(context, batchId) {
  return withTenant(context, async (tx) => {
    const batch = await tx.emrStoreBatch.findFirst({ where: { organizationId: context.organizationId, id: batchId } });
    if (!batch) throw new EmrError('STORE_BATCH_NOT_FOUND');
    await lockItem(tx, context, batch.itemId);
    const { count } = await tx.emrStoreBatch.updateMany({
      where: { organizationId: context.organizationId, id: batchId, status: 'QUARANTINED' },
      data: { status: 'ACTIVE', quarantineReason: null, quarantinedByUserId: null, quarantinedAt: null },
    });
    if (count !== 1) throw new EmrError('INVALID_STATE', { message: 'This batch is not in quarantine.' });
    await recordAudit(tx, context, { action: 'stores.released', resourceType: 'store_batch', resourceId: batchId });
    return { batchId, status: 'ACTIVE' };
  });
}
export async function recallLot(context, { itemId, batchNumber, reason }) {
  return withTenant(context, async (tx) => {
    await lockItem(tx, context, itemId);
    const { count } = await tx.emrStoreBatch.updateMany({
      where: { organizationId: context.organizationId, itemId, batchNumber, status: 'ACTIVE', qtyRemaining: { gt: 0 } },
      data: { status: 'QUARANTINED', quarantineReason: `Recall: ${reason}`, quarantinedByUserId: context.userId, quarantinedAt: new Date() },
    });
    if (!count) throw new EmrError('INVALID_STATE', { message: `No stock of batch ${batchNumber} is left to recall.` });
    await recordAudit(tx, context, { action: 'stores.recalled', resourceType: 'store_item', resourceId: itemId, changedFields: [batchNumber] });
    return { quarantined: count };
  });
}

// ---- transfers ------------------------------------------------------------------------------------
async function relocate(tx, context, item, { qty, fromLocationId, toLocationId, reference, requisitionId }) {
  if (fromLocationId === toLocationId) throw new EmrError('VALIDATION_FAILED', { message: 'Choose two different locations.' });
  await activeLocation(tx, context, fromLocationId, 'source');
  await activeLocation(tx, context, toLocationId, 'destination');
  const transferId = randomUUID();
  const link = { transferId, requisitionId: requisitionId ?? null, reference: reference ?? null };
  const taken = await consumeFefo(tx, context, item, fromLocationId, qty, 'TRANSFER_OUT', link);
  for (const { batch, qty: moved } of taken) {
    // The batch keeps its identity (number, expiry, cost) at the destination.
    const arrival = await newBatch(tx, context, { itemId: item.id, locationId: toLocationId, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, qtyReceived: moved, unitCostMinor: batch.unitCostMinor, source: 'TRANSFER', reference: reference ?? null });
    await moveStock(tx, context, arrival, moved, 'TRANSFER_IN', link);
  }
  const valueMinor = taken.reduce((n, t) => n + t.qty * Number(t.batch.unitCostMinor), 0);
  await tx.emrStoreTransfer.create({
    data: { id: transferId, organizationId: context.organizationId, itemId: item.id, qty, valueMinor: BigInt(valueMinor), fromLocationId, toLocationId, reference: reference ?? null, requisitionId: requisitionId ?? null, userId: context.userId },
  });
  return { transferId, valueMinor };
}

export async function transfer(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'stores.transfer', body: input }, async () => {
    const item = await lockItem(tx, context, input.itemId);
    const moved = await relocate(tx, context, item, input);
    await recordAudit(tx, context, { action: 'stores.transferred', resourceType: 'store_item', resourceId: item.id });
    return { statusCode: 201, body: moved };
  }));
}

// ---- requisitions ---------------------------------------------------------------------------------
const reqNumber = (year, n) => `REQ-${year}-${String(n).padStart(6, '0')}`;

export async function createRequisition(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'stores.requisition', body: input }, async () => {
    await activeLocation(tx, context, input.requestingLocationId, 'requesting location');
    const items = await tx.emrStoreItem.findMany({ where: { organizationId: context.organizationId, id: { in: input.lines.map((l) => l.itemId) }, active: true }, select: { id: true } });
    if (items.length !== new Set(input.lines.map((l) => l.itemId)).size) throw new EmrError('VALIDATION_FAILED', { message: 'Every requested item must be an active store item.' });
    const year = new Date().getUTCFullYear();
    const requisition = await tx.emrStoreRequisition.create({
      data: {
        organizationId: context.organizationId, number: reqNumber(year, await nextSequence(tx, context, `store_requisition_${year}`)), requestingLocationId: input.requestingLocationId,
        neededBy: input.neededBy ? new Date(`${input.neededBy}T00:00:00.000Z`) : null, justification: input.justification ?? null,
        status: input.submit ? 'PENDING_APPROVAL' : 'DRAFT', requestedByUserId: context.userId,
      },
    });
    await tx.emrStoreRequisitionLine.createMany({ data: input.lines.map((l) => ({ organizationId: context.organizationId, requisitionId: requisition.id, itemId: l.itemId, qtyRequested: l.qtyRequested })) });
    await recordAudit(tx, context, { action: 'store_requisition.created', resourceType: 'store_requisition', resourceId: requisition.id });
    return { statusCode: 201, body: { id: requisition.id, number: requisition.number, status: requisition.status } };
  }));
}

const REQ_STEPS = {
  submit: { from: ['DRAFT'], data: () => ({ status: 'PENDING_APPROVAL' }) },
  approve: { from: ['PENDING_APPROVAL'], data: (context) => ({ status: 'APPROVED', decidedByUserId: context.userId, decidedAt: new Date() }) },
  reject: { from: ['PENDING_APPROVAL'], data: (context, input) => ({ status: 'REJECTED', decidedByUserId: context.userId, decidedAt: new Date(), rejectionReason: input.reason }) },
  cancel: { from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'], data: () => ({ status: 'CANCELLED' }) },
};

export async function stepRequisition(context, requisitionId, expectedVersion, action, input = {}) {
  return withTenant(context, async (tx) => {
    const requisition = await tx.emrStoreRequisition.findFirst({ where: { organizationId: context.organizationId, id: requisitionId } });
    if (!requisition) throw new EmrError('STORE_REQUISITION_NOT_FOUND');
    const step = REQ_STEPS[action];
    if (!step.from.includes(requisition.status)) throw new EmrError('INVALID_STATE', { message: `A requisition that is ${requisition.status.toLowerCase().replace('_', ' ')} cannot be ${action === 'submit' ? 'submitted' : `${action}${action.endsWith('e') ? 'd' : 'ed'}`}.` });
    await updateVersioned(tx.emrStoreRequisition, { organizationId: context.organizationId, id: requisitionId, expectedVersion, data: { ...step.data(context, input), updatedAt: new Date() }, notFoundCode: 'STORE_REQUISITION_NOT_FOUND' });
    await recordAudit(tx, context, { action: `store_requisition.${action}`, resourceType: 'store_requisition', resourceId: requisitionId });
    return { id: requisitionId, action };
  });
}

/** Moves what the store can supply now (up to what is still outstanding) to the requesting location. */
export async function fulfilRequisition(context, requisitionId, expectedVersion, { fulfillingLocationId }) {
  return withTenant(context, async (tx) => {
    const requisition = await tx.emrStoreRequisition.findFirst({ where: { organizationId: context.organizationId, id: requisitionId }, include: { lines: true } });
    if (!requisition) throw new EmrError('STORE_REQUISITION_NOT_FOUND');
    if (!['APPROVED', 'PARTIALLY_FULFILLED'].includes(requisition.status)) throw new EmrError('INVALID_STATE', { message: 'Only an approved requisition can be fulfilled.' });
    if (fulfillingLocationId === requisition.requestingLocationId) throw new EmrError('VALIDATION_FAILED', { message: 'Fulfil from a different location than the one asking.' });
    await activeLocation(tx, context, fulfillingLocationId, 'fulfilling location');
    let issued = 0;
    for (const line of [...requisition.lines].sort((a, b) => a.itemId.localeCompare(b.itemId))) { // stable lock order
      const outstanding = line.qtyRequested - line.qtyIssued;
      if (!outstanding) continue;
      const item = await lockItem(tx, context, line.itemId);
      const available = (await tx.emrStoreBatch.findMany({ where: { organizationId: context.organizationId, itemId: item.id, locationId: fulfillingLocationId, qtyRemaining: { gt: 0 } } }))
        .filter((b) => usable(b)).reduce((n, b) => n + b.qtyRemaining, 0);
      const qty = Math.min(outstanding, available);
      if (!qty) continue;
      await relocate(tx, context, item, { qty, fromLocationId: fulfillingLocationId, toLocationId: requisition.requestingLocationId, reference: requisition.number, requisitionId });
      await tx.emrStoreRequisitionLine.updateMany({ where: { organizationId: context.organizationId, id: line.id }, data: { qtyIssued: line.qtyIssued + qty } });
      line.qtyIssued += qty;
      issued += qty;
    }
    if (!issued) throw new EmrError('INSUFFICIENT_STOCK', { message: 'Nothing on this requisition is in usable stock at that location.' });
    const done = requisition.lines.every((l) => l.qtyIssued >= l.qtyRequested);
    await updateVersioned(tx.emrStoreRequisition, {
      organizationId: context.organizationId, id: requisitionId, expectedVersion, notFoundCode: 'STORE_REQUISITION_NOT_FOUND',
      data: { status: done ? 'FULFILLED' : 'PARTIALLY_FULFILLED', fulfillingLocationId, updatedAt: new Date() },
    });
    await recordAudit(tx, context, { action: 'store_requisition.fulfilled', resourceType: 'store_requisition', resourceId: requisitionId });
    return { issued, status: done ? 'FULFILLED' : 'PARTIALLY_FULFILLED' };
  });
}

// ---- stock counts ---------------------------------------------------------------------------------
const countNumber = (year, n) => `CNT-${year}-${String(n).padStart(6, '0')}`;
const heldAt = async (tx, context, itemId, locationId) => (await tx.emrStoreBatch.aggregate({ where: { organizationId: context.organizationId, itemId, locationId }, _sum: { qtyRemaining: true } }))._sum.qtyRemaining ?? 0;

export async function createCount(context, input) {
  return withTenant(context, async (tx) => {
    await activeLocation(tx, context, input.locationId);
    const items = await tx.emrStoreItem.findMany({ where: { organizationId: context.organizationId, id: { in: input.itemIds } }, select: { id: true } });
    if (items.length !== new Set(input.itemIds).size) throw new EmrError('VALIDATION_FAILED', { message: 'Count only this hospital\'s store items.' });
    const year = new Date().getUTCFullYear();
    const lines = [];
    for (const itemId of input.itemIds) lines.push({ itemId, systemQty: await heldAt(tx, context, itemId, input.locationId) });
    const count = await tx.emrStoreCount.create({
      data: { ...(input.id ? { id: input.id } : {}), organizationId: context.organizationId, number: countNumber(year, await nextSequence(tx, context, `store_count_${year}`)), locationId: input.locationId, note: input.note ?? null, createdByUserId: context.userId },
    });
    await tx.emrStoreCountLine.createMany({ data: lines.map((l) => ({ ...l, organizationId: context.organizationId, countId: count.id })) });
    await recordAudit(tx, context, { action: 'store_count.created', resourceType: 'store_count', resourceId: count.id });
    return { id: count.id, number: count.number };
  });
}
export async function recordCountLine(context, countId, { itemId, countedQty }) {
  return withTenant(context, async (tx) => {
    const count = await tx.emrStoreCount.findFirst({ where: { organizationId: context.organizationId, id: countId } });
    if (!count) throw new EmrError('STORE_COUNT_NOT_FOUND');
    if (count.status !== 'DRAFT') throw new EmrError('INVALID_STATE', { message: 'This count is already posted.' });
    const { count: changed } = await tx.emrStoreCountLine.updateMany({ where: { organizationId: context.organizationId, countId, itemId }, data: { countedQty } });
    if (!changed) throw new EmrError('VALIDATION_FAILED', { message: 'That item is not on this count.' });
    return { countId, itemId, countedQty };
  });
}
/** Posts each counted line's variance against the stock held now as a COUNT adjustment. */
export async function postCount(context, countId, expectedVersion) {
  return withTenant(context, async (tx) => {
    const count = await tx.emrStoreCount.findFirst({ where: { organizationId: context.organizationId, id: countId }, include: { lines: true } });
    if (!count) throw new EmrError('STORE_COUNT_NOT_FOUND');
    if (count.status !== 'DRAFT') throw new EmrError('INVALID_STATE', { message: 'This count is already posted.' });
    const counted = count.lines.filter((l) => l.countedQty !== null);
    if (!counted.length) throw new EmrError('VALIDATION_FAILED', { message: 'Enter at least one counted quantity before posting.' });
    let adjustments = 0;
    for (const line of [...counted].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
      const item = await lockItem(tx, context, line.itemId);
      const delta = line.countedQty - (await heldAt(tx, context, item.id, count.locationId));
      if (!delta) continue;
      try {
        await applyDelta(tx, context, item, count.locationId, delta, 'COUNT', { countId, reference: count.number });
      } catch (error) {
        if (error instanceof EmrError && error.code === 'INSUFFICIENT_STOCK') {
          throw new EmrError('INVALID_STATE', { message: `${item.name}: part of the stock here is quarantined or expired — resolve it before posting this count.` });
        }
        throw error;
      }
      adjustments += 1;
    }
    await updateVersioned(tx.emrStoreCount, { organizationId: context.organizationId, id: countId, expectedVersion, notFoundCode: 'STORE_COUNT_NOT_FOUND', data: { status: 'POSTED', postedByUserId: context.userId, postedAt: new Date() } });
    await recordAudit(tx, context, { action: 'store_count.posted', resourceType: 'store_count', resourceId: countId });
    return { adjustments };
  });
}

