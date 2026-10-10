// Laboratory use cases. Order → collect (accession number) → enter results → verify/release →
// amend. Every change is audited and emits outbox events in the same transaction; events carry
// identifiers only (never values or test names).
//
// Concurrency: every result change first locks its ORDER row (FOR UPDATE). Two scientists
// verifying different tests of one order therefore run one after the other, so exactly one of
// them sees "all tests verified" and completes the order. The lock is per order, never wider.
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit, changedFieldNames } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { nextSequence } from '../core/sequence.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { activeMemberWithPermission } from '../core/membership.js';
import { userNameMap } from '../core/people.js';
import { requireOpen } from '../encounters/encounters.policy.js';
import { DEFAULT_TESTS } from './lab.catalog.js';
import * as policy from './lab.policy.js';

const num = (value) => (value === null || value === undefined ? null : Number(value));
const toResult = (row) => ({ ...row, valueNumeric: num(row.valueNumeric), referenceLow: num(row.referenceLow), referenceHigh: num(row.referenceHigh) });
const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
const toOrder = (order) => ({
  ...order,
  ...(order.patient ? { patient: { ...order.patient, dateOfBirth: dateOnly(order.patient.dateOfBirth) } } : {}),
  ...(order.items ? { items: order.items.map((item) => ({ ...item, ...(item.results ? { results: item.results.map(toResult) } : {}) })) } : {}),
});

// Minimum identity the lab needs to label and match specimens — no contact or clinical details.
const labPatient = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const currentResults = { where: { status: { not: 'SUPERSEDED' } }, orderBy: { analyteCode: 'asc' } };

// ---------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------
/** UC-4 style lazy provisioning: a tenant gets the starter catalog the first time it looks. */
async function ensureCatalog(tx, context) {
  if (await tx.emrLabTest.count({ where: { organizationId: context.organizationId } })) return;
  await tx.emrLabTest.createMany({
    data: DEFAULT_TESTS.map((test) => ({ ...test, organizationId: context.organizationId })),
    skipDuplicates: true,
  });
}

export async function listTests(context, { includeInactive }) {
  return withTenant(context, async (tx) => {
    await ensureCatalog(tx, context);
    return tx.emrLabTest.findMany({
      where: { organizationId: context.organizationId, ...(includeInactive === 'true' ? {} : { active: true }) },
      orderBy: { code: 'asc' },
    });
  });
}

export async function createTest(context, input) {
  try {
    return await withTenant(context, async (tx) => {
      await ensureCatalog(tx, context);
      const test = await tx.emrLabTest.create({ data: { ...input, organizationId: context.organizationId } });
      await recordAudit(tx, context, { action: 'lab_test.created', resourceType: 'lab_test', resourceId: test.id });
      return test;
    });
  } catch (error) {
    throw uniqueViolation(error, { code: 'LAB_TEST_CODE_IN_USE' }) ?? error;
  }
}

export async function updateTest(context, code, expectedVersion, changes) {
  return withTenant(context, async (tx) => {
    await ensureCatalog(tx, context);
    const current = await tx.emrLabTest.findFirst({ where: { organizationId: context.organizationId, code } });
    if (!current) throw new EmrError('LAB_TEST_NOT_FOUND');
    const test = await updateVersioned(tx.emrLabTest, { organizationId: context.organizationId, id: current.id, expectedVersion, data: changes, notFoundCode: 'LAB_TEST_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'lab_test.updated', resourceType: 'lab_test', resourceId: test.id, changedFields: changedFieldNames(current, changes) });
    return test;
  });
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------
export async function orderTests(context, encounterId, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: `lab.order:${encounterId}`, body: input }, async () => {
    const encounter = await tx.emrEncounter.findFirst({ where: { organizationId: context.organizationId, id: encounterId }, select: { id: true, patientId: true, status: true } });
    if (!encounter) throw new EmrError('ENCOUNTER_NOT_FOUND');
    requireOpen(encounter);
    await ensureCatalog(tx, context);
    const tests = await tx.emrLabTest.findMany({ where: { organizationId: context.organizationId, code: { in: input.tests }, active: true } });
    const unknown = input.tests.filter((code) => !tests.some((t) => t.code === code));
    if (unknown.length) throw new EmrError('VALIDATION_FAILED', { message: `Unknown or inactive tests: ${unknown.join(', ')}.` });

    const order = await tx.emrLabOrder.create({
      data: {
        organizationId: context.organizationId, encounterId, patientId: encounter.patientId, priority: input.priority,
        clinicalNotes: input.clinicalNotes, orderedByUserId: context.userId,
        items: { create: input.tests.map((code) => {
          const test = tests.find((t) => t.code === code);
          return { testCode: test.code, testName: test.name, specimenType: test.specimenType, analytes: test.analytes };
        }) },
      },
      include: { items: true },
    });
    await recordAudit(tx, context, { action: 'lab_order.created', resourceType: 'lab_order', resourceId: order.id, changedFields: input.tests });
    await enqueueEvent(tx, context, { type: 'lab.ordered', aggregateType: 'lab_order', aggregateId: order.id, data: { encounterId, patientId: encounter.patientId, priority: order.priority, tests: order.items.length } });
    return { statusCode: 201, body: toOrder(order) };
  }));
}

export async function listEncounterOrders(context, encounterId) {
  return withTenant(context, async (tx) => {
    const encounter = await tx.emrEncounter.findFirst({ where: { organizationId: context.organizationId, id: encounterId }, select: { id: true } });
    if (!encounter) throw new EmrError('ENCOUNTER_NOT_FOUND');
    const orders = await tx.emrLabOrder.findMany({
      where: { organizationId: context.organizationId, encounterId },
      include: { items: { include: { results: currentResults }, orderBy: { testCode: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    await recordAudit(tx, context, { action: 'lab_result.viewed', resourceType: 'encounter', resourceId: encounterId });
    return orders.map(toOrder);
  });
}

const ORDER_PEOPLE = ['orderedByUserId', 'collectedByUserId', 'cancelledByUserId'];
const ITEM_PEOPLE = ['resultedByUserId', 'verifiedByUserId', 'returnedByUserId', 'acknowledgedByUserId', 'criticalCommunicatedByUserId', 'criticalCommunicatedToUserId'];
const nameField = (field) => field.replace(/UserId$/, 'Name');

/** Adds the display name beside every staff id on the orders and their tests (e.g. verifiedByName). */
async function withStaffNames(tx, orders) {
  const ids = orders.flatMap((order) => [...ORDER_PEOPLE.map((f) => order[f]), ...order.items.flatMap((item) => ITEM_PEOPLE.map((f) => item[f]))]);
  const names = await userNameMap(tx, ids);
  const named = (row, fields) => ({ ...row, ...Object.fromEntries(fields.map((f) => [nameField(f), names.get(row[f]) ?? null])) });
  return orders.map((order) => ({ ...named(order, ORDER_PEOPLE), items: order.items.map((item) => named(item, ITEM_PEOPLE)) }));
}

/**
 * Lab worklist with each test's current results and the staff names behind every step. Oldest
 * first by default (first in, first out); newest first for recent results. STAT/URGENT can be
 * filtered for.
 */
export async function worklist(context, { status, priority, patientId, limit, cursor, sort }) {
  const direction = sort === 'newest' ? 'desc' : 'asc';
  const after = afterCursor('createdAt', cursor, direction);
  return withTenant(context, async (tx) => {
    const rows = await tx.emrLabOrder.findMany({
      where: {
        organizationId: context.organizationId,
        status: { in: status ?? ['ORDERED', 'COLLECTED', 'IN_PROGRESS'] },
        ...(priority ? { priority } : {}),
        ...(patientId ? { patientId } : {}),
        ...after,
      },
      include: { patient: labPatient, items: { include: { results: currentResults }, orderBy: { testCode: 'asc' } } },
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'lab_worklist.viewed', resourceType: 'lab_order' });
    const result = page(rows, limit, 'createdAt');
    return { ...result, items: (await withStaffNames(tx, result.items)).map(toOrder) };
  });
}

/** A patient's orders in every status, newest first, with results and staff names (the patient record). */
export async function labOrdersForPatient(tx, context, patientId, take) {
  const rows = await tx.emrLabOrder.findMany({
    where: { organizationId: context.organizationId, patientId },
    include: { patient: labPatient, items: { include: { results: currentResults }, orderBy: { testCode: 'asc' } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  });
  return (await withStaffNames(tx, rows)).map(toOrder);
}

export async function getOrder(context, orderId) {
  return withTenant(context, async (tx) => {
    const order = await tx.emrLabOrder.findFirst({
      where: { organizationId: context.organizationId, id: orderId },
      include: { patient: labPatient, items: { include: { results: { orderBy: [{ analyteCode: 'asc' }, { enteredAt: 'asc' }] } }, orderBy: { testCode: 'asc' } } },
    });
    if (!order) throw new EmrError('LAB_ORDER_NOT_FOUND');
    await recordAudit(tx, context, { action: 'lab_order.viewed', resourceType: 'lab_order', resourceId: orderId });
    return toOrder(order); // includes superseded results: the full amendment history
  });
}

async function loadOrder(tx, context, orderId) {
  const order = await tx.emrLabOrder.findFirst({ where: { organizationId: context.organizationId, id: orderId }, include: { items: { select: { id: true, status: true } } } });
  if (!order) throw new EmrError('LAB_ORDER_NOT_FOUND');
  return order;
}

const updateOrder = (tx, context, orderId, expectedVersion, data) =>
  updateVersioned(tx.emrLabOrder, { organizationId: context.organizationId, id: orderId, expectedVersion, data, notFoundCode: 'LAB_ORDER_NOT_FOUND' });

export async function collectSpecimen(context, orderId, expectedVersion, { note }) {
  return withTenant(context, async (tx) => {
    const order = await loadOrder(tx, context, orderId);
    policy.requireOrderStatus(order, ['ORDERED'], 'collected');
    const now = new Date();
    const year = now.getUTCFullYear();
    const accessionNumber = policy.accessionNumber(year, await nextSequence(tx, context, `lab_accession_${year}`));
    const row = await updateOrder(tx, context, orderId, expectedVersion, { status: 'COLLECTED', accessionNumber, collectedAt: now, collectedByUserId: context.userId, specimenNote: note });
    await recordAudit(tx, context, { action: 'lab_specimen.collected', resourceType: 'lab_order', resourceId: orderId });
    return toOrder(row);
  });
}

export async function cancelOrder(context, orderId, expectedVersion, { reason }) {
  return withTenant(context, async (tx) => {
    const order = await loadOrder(tx, context, orderId);
    policy.requireOrderStatus(order, ['ORDERED', 'COLLECTED'], 'cancelled');
    const row = await updateOrder(tx, context, orderId, expectedVersion, { status: 'CANCELLED', cancelledAt: new Date(), cancelledByUserId: context.userId, cancellationReason: reason });
    await recordAudit(tx, context, { action: 'lab_order.cancelled', resourceType: 'lab_order', resourceId: orderId });
    await enqueueEvent(tx, context, { type: 'lab.order.cancelled', aggregateType: 'lab_order', aggregateId: orderId, data: { patientId: order.patientId } });
    return toOrder(row);
  });
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------
async function lockOrder(tx, context, orderId) {
  const locked = await tx.$queryRaw`
    SELECT "id" FROM "emr_lab_orders" WHERE "organization_id" = ${context.organizationId} AND "id" = ${orderId} FOR UPDATE`;
  if (!locked.length) throw new EmrError('LAB_ORDER_NOT_FOUND');
  const order = await tx.emrLabOrder.findFirst({
    where: { organizationId: context.organizationId, id: orderId },
    include: { patient: { select: { sex: true } }, items: { select: { id: true, status: true } } },
  });
  return order;
}

async function loadItem(tx, context, order, itemId) {
  const item = await tx.emrLabOrderItem.findFirst({ where: { organizationId: context.organizationId, orderId: order.id, id: itemId } });
  if (!item) throw new EmrError('LAB_ITEM_NOT_FOUND');
  return item;
}

const updateItem = (tx, context, itemId, expectedVersion, data) =>
  updateVersioned(tx.emrLabOrderItem, { organizationId: context.organizationId, id: itemId, expectedVersion, data, notFoundCode: 'LAB_ITEM_NOT_FOUND' });

async function itemWithResults(tx, context, itemId) {
  const item = await tx.emrLabOrderItem.findFirst({ where: { organizationId: context.organizationId, id: itemId }, include: { results: currentResults } });
  return { ...item, results: item.results.map(toResult) };
}

/** Enter (or re-enter, before verification) every analyte of one ordered test. */
export async function enterResults(context, orderId, itemId, expectedVersion, { results }) {
  return withTenant(context, async (tx) => {
    const order = await lockOrder(tx, context, orderId);
    policy.requireOrderStatus(order, ['COLLECTED', 'IN_PROGRESS'], 'resulted');
    const item = await loadItem(tx, context, order, itemId);
    if (item.status === 'VERIFIED') throw new EmrError('INVALID_STATE', { message: 'This test is verified; amend it instead.' });
    const rows = policy.interpretAll(item.analytes, results, order.patient.sex);

    await tx.emrLabResult.deleteMany({ where: { organizationId: context.organizationId, itemId, status: 'PRELIMINARY' } });
    await tx.emrLabResult.createMany({ data: rows.map((row) => ({ ...row, organizationId: context.organizationId, itemId, enteredByUserId: context.userId })) });
    await updateItem(tx, context, itemId, expectedVersion, { status: 'RESULTED', resultedAt: new Date(), resultedByUserId: context.userId });
    if (order.status === 'COLLECTED') await tx.emrLabOrder.updateMany({ where: { organizationId: context.organizationId, id: orderId }, data: { status: 'IN_PROGRESS', version: { increment: 1 } } });
    await recordAudit(tx, context, { action: 'lab_result.entered', resourceType: 'lab_order_item', resourceId: itemId, changedFields: rows.map((r) => r.analyteCode) });
    return itemWithResults(tx, context, itemId);
  });
}

async function completeIfDone(tx, context, orderId) {
  const open = await tx.emrLabOrderItem.count({ where: { organizationId: context.organizationId, orderId, status: { not: 'VERIFIED' } } });
  if (open) return false;
  await tx.emrLabOrder.updateMany({ where: { organizationId: context.organizationId, id: orderId }, data: { status: 'COMPLETED', completedAt: new Date(), version: { increment: 1 } } });
  return true;
}

async function announce(tx, context, { type, order, itemId, rows }) {
  const base = { orderId: order.id, itemId, patientId: order.patientId, encounterId: order.encounterId };
  await enqueueEvent(tx, context, { type, aggregateType: 'lab_order', aggregateId: order.id, data: base });
  const critical = rows.filter((r) => policy.isCritical(r.flag)).length;
  if (critical) await enqueueEvent(tx, context, { type: 'lab.result.critical', aggregateType: 'lab_order', aggregateId: order.id, data: { ...base, criticalCount: critical } });
}

/** Verify and release one test: its values become FINAL (locked by the database). */
export async function verifyResults(context, orderId, itemId, expectedVersion) {
  return withTenant(context, async (tx) => {
    const order = await lockOrder(tx, context, orderId);
    const item = await loadItem(tx, context, order, itemId);
    if (item.status !== 'RESULTED') throw new EmrError('INVALID_STATE', { message: item.status === 'VERIFIED' ? 'This test is already verified.' : 'Enter results before verifying.' });
    await tx.emrLabResult.updateMany({ where: { organizationId: context.organizationId, itemId, status: 'PRELIMINARY' }, data: { status: 'FINAL' } });
    await updateItem(tx, context, itemId, expectedVersion, { status: 'VERIFIED', verifiedAt: new Date(), verifiedByUserId: context.userId });
    const completed = await completeIfDone(tx, context, orderId);
    const released = await itemWithResults(tx, context, itemId);
    await recordAudit(tx, context, { action: 'lab_result.verified', resourceType: 'lab_order_item', resourceId: itemId });
    await announce(tx, context, { type: 'lab.result.released', order, itemId, rows: released.results });
    return { ...released, orderCompleted: completed };
  });
}

/** Send an unverified result back to the bench for correction; it is re-entered, then verified. */
export async function returnForCorrection(context, orderId, itemId, expectedVersion, { reason }) {
  return withTenant(context, async (tx) => {
    const order = await lockOrder(tx, context, orderId);
    const item = await loadItem(tx, context, order, itemId);
    if (item.status !== 'RESULTED') throw new EmrError('INVALID_STATE', { message: 'Only a result awaiting verification can be sent back.' });
    await updateItem(tx, context, itemId, expectedVersion, { status: 'PENDING', returnReason: reason, returnedAt: new Date(), returnedByUserId: context.userId });
    await recordAudit(tx, context, { action: 'lab_result.returned', resourceType: 'lab_order_item', resourceId: itemId });
    return itemWithResults(tx, context, itemId);
  });
}

/** The clinician confirms they have seen a released result (once). */
export async function acknowledgeResults(context, orderId, itemId, expectedVersion) {
  return withTenant(context, async (tx) => {
    const order = await lockOrder(tx, context, orderId);
    const item = await loadItem(tx, context, order, itemId);
    if (item.status !== 'VERIFIED') throw new EmrError('INVALID_STATE', { message: 'Only released results can be acknowledged.' });
    if (item.acknowledgedAt) throw new EmrError('INVALID_STATE', { message: 'This result has already been acknowledged.' });
    await updateItem(tx, context, itemId, expectedVersion, { acknowledgedAt: new Date(), acknowledgedByUserId: context.userId });
    await recordAudit(tx, context, { action: 'lab_result.acknowledged', resourceType: 'lab_order_item', resourceId: itemId });
    await enqueueEvent(tx, context, { type: 'lab.result.acknowledged', aggregateType: 'lab_order', aggregateId: orderId, data: { orderId, itemId, patientId: order.patientId } });
    return itemWithResults(tx, context, itemId);
  });
}

/** Records that the lab told a clinician about an abnormal or critical released result. */
export async function communicateCritical(context, orderId, itemId, expectedVersion, { toUserId }) {
  // The recipient must be a clinician of this hospital who can act on results (identity tables).
  if (!await activeMemberWithPermission(context.organizationId, toUserId, 'lab.order.create')) {
    throw new EmrError('VALIDATION_FAILED', { details: [{ field: 'toUserId', message: 'must be an active clinician of this organization' }] });
  }
  return withTenant(context, async (tx) => {
    const order = await lockOrder(tx, context, orderId);
    const item = await loadItem(tx, context, order, itemId);
    if (item.status !== 'VERIFIED') throw new EmrError('INVALID_STATE', { message: 'Only released results can be communicated.' });
    if (item.criticalCommunicatedAt) throw new EmrError('INVALID_STATE', { message: 'This result has already been communicated.' });
    const released = await itemWithResults(tx, context, itemId);
    if (!released.results.some((r) => r.flag && r.flag !== 'NORMAL')) throw new EmrError('INVALID_STATE', { message: 'Only abnormal results are communicated this way.' });
    await updateItem(tx, context, itemId, expectedVersion, { criticalCommunicatedAt: new Date(), criticalCommunicatedByUserId: context.userId, criticalCommunicatedToUserId: toUserId });
    await recordAudit(tx, context, { action: 'lab_result.communicated', resourceType: 'lab_order_item', resourceId: itemId });
    return itemWithResults(tx, context, itemId);
  });
}

/** Correct a released test. The old values stay, marked SUPERSEDED, with who/when/why. */
export async function amendResults(context, orderId, itemId, expectedVersion, { reason, results }) {
  return withTenant(context, async (tx) => {
    const order = await lockOrder(tx, context, orderId);
    const item = await loadItem(tx, context, order, itemId);
    if (item.status !== 'VERIFIED') throw new EmrError('INVALID_STATE', { message: 'Only a verified test can be amended; re-enter the results instead.' });
    const rows = policy.interpretAll(item.analytes, results, order.patient.sex);
    const now = new Date();
    await tx.emrLabResult.updateMany({
      where: { organizationId: context.organizationId, itemId, status: 'FINAL' },
      data: { status: 'SUPERSEDED', supersededAt: now, supersededByUserId: context.userId },
    });
    await tx.emrLabResult.createMany({
      data: rows.map((row) => ({ ...row, organizationId: context.organizationId, itemId, status: 'FINAL', enteredByUserId: context.userId, amendmentReason: reason })),
    });
    // Corrected values are new information: the clinician must see (and acknowledge) them again.
    await updateItem(tx, context, itemId, expectedVersion, {
      amendedAt: now, acknowledgedAt: null, acknowledgedByUserId: null,
      criticalCommunicatedAt: null, criticalCommunicatedByUserId: null, criticalCommunicatedToUserId: null,
    });
    await recordAudit(tx, context, { action: 'lab_result.amended', resourceType: 'lab_order_item', resourceId: itemId, changedFields: rows.map((r) => r.analyteCode) });
    await announce(tx, context, { type: 'lab.result.amended', order, itemId, rows });
    return itemWithResults(tx, context, itemId);
  });
}
