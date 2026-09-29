// Prices, charges, invoices, payments and statements.
//
// Money never changes silently: every change to what a patient owes (invoice issued, payment,
// reversal, void) writes an append-only ledger row with the running balance in the same
// transaction, and reconciliation() checks invoices against their charges, payments and ledger.
// Invoices and payments lock the invoice row (FOR UPDATE) first; issuing an invoice claims its
// charges with a guarded UPDATE, so each charge lands on exactly one invoice.
import { Buffer } from 'node:buffer';
import { withTenant } from '../core/db.js';
import { recordAudit, changedFieldNames } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { etagFor, updateVersioned } from '../core/concurrency.js';
import { nextSequence } from '../core/sequence.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { captureInTx } from './capture.service.js';
import { invoiceStatusFor, invoiceTotals, lineAmounts, money } from './billing.policy.js';

const numbered = (prefix, year, value) => `${prefix}-${year}-${String(value).padStart(6, '0')}`;
const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

export const toPrice = (row) => ({ ...row, unitPriceMinor: money(row.unitPriceMinor) });
export const toCharge = (row) => ({ ...row, unitPriceMinor: money(row.unitPriceMinor), amountMinor: money(row.amountMinor), taxMinor: money(row.taxMinor) });
export const toPayment = (row) => ({ ...row, amountMinor: money(row.amountMinor) });
const toLedger = (row) => ({ ...row, amountMinor: money(row.amountMinor), balanceAfterMinor: money(row.balanceAfterMinor) });
export function toInvoice(row) {
  const balance = row.status === 'VOID' ? 0n : BigInt(row.totalMinor) - BigInt(row.amountPaidMinor);
  return {
    ...row,
    subtotalMinor: money(row.subtotalMinor), taxMinor: money(row.taxMinor), discountMinor: money(row.discountMinor),
    totalMinor: money(row.totalMinor), amountPaidMinor: money(row.amountPaidMinor), balanceMinor: money(balance), dueDate: dateOnly(row.dueDate),
    ...(row.charges ? { charges: row.charges.map(toCharge) } : {}),
    ...(row.payments ? { payments: row.payments.map(toPayment) } : {}),
    ...(row.patient ? { patient: { ...row.patient, dateOfBirth: dateOnly(row.patient.dateOfBirth) } } : {}),
  };
}
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true } };

// ---------------------------------------------------------------------------------------------
// Price list
// ---------------------------------------------------------------------------------------------
export async function listPrices(context, { category, q, includeInactive }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrPriceItem.findMany({
      where: {
        organizationId: context.organizationId,
        ...(category ? { category } : {}),
        ...(includeInactive === 'true' ? {} : { active: true }),
        ...(q ? { OR: [{ reference: { startsWith: q.toUpperCase() } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: [{ category: 'asc' }, { reference: 'asc' }],
    });
    return rows.map(toPrice);
  });
}

export async function createPrice(context, input) {
  try {
    return await withTenant(context, async (tx) => {
      const row = await tx.emrPriceItem.create({ data: { ...input, unitPriceMinor: BigInt(input.unitPriceMinor), organizationId: context.organizationId } });
      await recordAudit(tx, context, { action: 'price.created', resourceType: 'price_item', resourceId: row.id });
      return toPrice(row);
    });
  } catch (error) {
    throw uniqueViolation(error, { reference: 'PRICE_REFERENCE_IN_USE' }) ?? error;
  }
}

/** Price changes apply to new charges only: charges keep the price they were captured at. */
export async function updatePrice(context, priceId, expectedVersion, changes) {
  return withTenant(context, async (tx) => {
    const current = await tx.emrPriceItem.findFirst({ where: { organizationId: context.organizationId, id: priceId } });
    if (!current) throw new EmrError('PRICE_ITEM_NOT_FOUND');
    const data = { ...changes, ...(changes.unitPriceMinor !== undefined ? { unitPriceMinor: BigInt(changes.unitPriceMinor) } : {}) };
    const row = await updateVersioned(tx.emrPriceItem, { organizationId: context.organizationId, id: priceId, expectedVersion, data, notFoundCode: 'PRICE_ITEM_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'price.updated', resourceType: 'price_item', resourceId: priceId, changedFields: changedFieldNames(toPrice(current), changes) });
    return toPrice(row);
  });
}

// ---------------------------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------------------------
async function requireEncounter(tx, context, encounterId) {
  const encounter = await tx.emrEncounter.findFirst({ where: { organizationId: context.organizationId, id: encounterId }, select: { id: true, patientId: true, status: true } });
  if (!encounter) throw new EmrError('ENCOUNTER_NOT_FOUND');
  return encounter;
}

export async function encounterCharges(context, encounterId) {
  return withTenant(context, async (tx) => {
    await requireEncounter(tx, context, encounterId);
    const charges = await tx.emrCharge.findMany({ where: { organizationId: context.organizationId, encounterId }, orderBy: [{ serviceAt: 'asc' }, { createdAt: 'asc' }] });
    const unbilled = charges.filter((c) => c.status === 'UNBILLED');
    await recordAudit(tx, context, { action: 'billing.charges_viewed', resourceType: 'encounter', resourceId: encounterId });
    return {
      items: charges.map(toCharge),
      unbilled: { count: unbilled.length, amountMinor: money(unbilled.reduce((s, c) => s + c.amountMinor + c.taxMinor, 0n)) },
    };
  });
}

/** A manual charge: from the price list, or a priced-by-hand procedure/other item. */
export async function addCharge(context, encounterId, input) {
  return withTenant(context, async (tx) => {
    const encounter = await requireEncounter(tx, context, encounterId);
    if (encounter.status === 'CANCELLED') throw new EmrError('INVALID_STATE', { message: 'A cancelled visit cannot be charged.' });
    let fields;
    if (input.priceItemId) {
      const price = await tx.emrPriceItem.findFirst({ where: { organizationId: context.organizationId, id: input.priceItemId, active: true } });
      if (!price) throw new EmrError('PRICE_ITEM_NOT_FOUND');
      fields = { priceItemId: price.id, category: price.category, description: input.description ?? price.name, unitPriceMinor: price.unitPriceMinor, taxRateBp: price.taxRateBp, currency: price.currency };
    } else {
      fields = { priceItemId: null, category: input.category, description: input.description, unitPriceMinor: BigInt(input.unitPriceMinor), taxRateBp: input.taxRateBp ?? 0, currency: input.currency ?? 'NGN' };
    }
    const row = await tx.emrCharge.create({
      data: {
        ...fields, ...lineAmounts(input.quantity, fields.unitPriceMinor, fields.taxRateBp),
        organizationId: context.organizationId, patientId: encounter.patientId, encounterId, quantity: input.quantity,
        sourceType: 'MANUAL', sourceKey: null, serviceAt: new Date(), createdByUserId: context.userId,
      },
    });
    await recordAudit(tx, context, { action: 'charge.added', resourceType: 'charge', resourceId: row.id });
    return toCharge(row);
  });
}

/** Voids an unbilled charge. A voided captured charge is not captured again (a write-off). */
export async function voidCharge(context, chargeId, { reason }) {
  return withTenant(context, async (tx) => {
    const { count } = await tx.emrCharge.updateMany({
      where: { organizationId: context.organizationId, id: chargeId, status: 'UNBILLED' },
      data: { status: 'VOIDED', voidedAt: new Date(), voidedByUserId: context.userId, voidReason: reason },
    });
    const row = await tx.emrCharge.findFirst({ where: { organizationId: context.organizationId, id: chargeId } });
    if (!row) throw new EmrError('CHARGE_NOT_FOUND');
    if (!count) throw new EmrError('INVALID_STATE', { message: `This charge is ${row.status.toLowerCase()}; only unbilled charges can be voided.` });
    await recordAudit(tx, context, { action: 'charge.voided', resourceType: 'charge', resourceId: chargeId });
    return toCharge(row);
  });
}

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------
const ledger = (tx, context, invoice, { kind, amountMinor, balanceAfterMinor, paymentId = null }) =>
  tx.emrBillingLedger.create({ data: { organizationId: context.organizationId, invoiceId: invoice.id, patientId: invoice.patientId, kind, amountMinor, balanceAfterMinor, paymentId, createdByUserId: context.userId } });

export async function createInvoice(context, encounterId, input, { idempotencyKey } = {}) {
  const discount = BigInt(input.discountMinor ?? 0);
  if (discount > 0n && !context.permissions.includes('billing.discount')) throw new EmrError('PERMISSION_DENIED', { message: 'You are not allowed to give discounts.' });
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: `invoice:${encounterId}`, body: input }, async () => {
    const encounter = await requireEncounter(tx, context, encounterId);
    const captured = await captureInTx(tx, context, encounterId);
    // FOR UPDATE: a concurrent invoice for the same visit waits here, then finds nothing left.
    const claimable = await tx.$queryRaw`
      SELECT "id" FROM "emr_charges"
      WHERE "organization_id" = ${context.organizationId} AND "encounter_id" = ${encounterId} AND "status" = 'UNBILLED'
      ORDER BY "id" FOR UPDATE`;
    if (!claimable.length) throw new EmrError('NOTHING_TO_INVOICE', { details: { unpriced: captured.unpriced } });
    const charges = await tx.emrCharge.findMany({ where: { organizationId: context.organizationId, id: { in: claimable.map((c) => c.id) } } });
    const currencies = [...new Set(charges.map((c) => c.currency))];
    if (currencies.length > 1) throw new EmrError('INVALID_STATE', { message: `Charges are in several currencies (${currencies.join(', ')}).` });
    const totals = invoiceTotals(charges, discount);
    const now = new Date();
    const number = numbered('INV', now.getUTCFullYear(), await nextSequence(tx, context, `invoice_${now.getUTCFullYear()}`));
    const status = invoiceStatusFor(totals.totalMinor, 0n);
    const invoice = await tx.emrInvoice.create({
      data: {
        organizationId: context.organizationId, patientId: encounter.patientId, encounterId, number, status, currency: currencies[0],
        ...totals, discountReason: discount > 0n ? input.discountReason : null,
        dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null, issuedAt: now, issuedByUserId: context.userId,
      },
    });
    const { count } = await tx.emrCharge.updateMany({
      where: { organizationId: context.organizationId, id: { in: charges.map((c) => c.id) }, status: 'UNBILLED' },
      data: { status: 'INVOICED', invoiceId: invoice.id },
    });
    if (count !== charges.length) throw new Error('Charges changed while locked for invoicing');
    await ledger(tx, context, invoice, { kind: 'INVOICE_ISSUED', amountMinor: totals.totalMinor, balanceAfterMinor: totals.totalMinor });
    await recordAudit(tx, context, { action: 'invoice.issued', resourceType: 'invoice', resourceId: invoice.id, changedFields: discount > 0n ? ['discount'] : [] });
    await enqueueEvent(tx, context, { type: 'invoice.issued', aggregateType: 'invoice', aggregateId: invoice.id, data: { patientId: encounter.patientId, encounterId, number } });
    const body = toInvoice({ ...invoice, charges: await tx.emrCharge.findMany({ where: { organizationId: context.organizationId, invoiceId: invoice.id }, orderBy: { serviceAt: 'asc' } }) });
    return { statusCode: 201, body: { ...body, unpriced: captured.unpriced } };
  }));
}

const cursorOf = (row) => Buffer.from(`${row.issuedAt.toISOString()}|${row.id}`).toString('base64url');
function parseCursor(cursor) {
  const [issuedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = new Date(issuedAt);
  if (!id || Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw new EmrError('VALIDATION_FAILED', { message: 'The cursor is not valid.' });
  return { issuedAt: date, id };
}

export async function listInvoices(context, { status, patientId, cursor, limit }) {
  const after = cursor ? parseCursor(cursor) : null;
  return withTenant(context, async (tx) => {
    const rows = await tx.emrInvoice.findMany({
      where: {
        organizationId: context.organizationId,
        ...(status ? { status: { in: status } } : {}),
        ...(patientId ? { patientId } : {}),
        ...(after ? { OR: [{ issuedAt: { lt: after.issuedAt } }, { issuedAt: after.issuedAt, id: { lt: after.id } }] } : {}),
      },
      include: { patient: patientSummary },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'invoice.listed', resourceType: 'invoice' });
    return { items: rows.slice(0, limit).map(toInvoice), nextCursor: rows.length > limit ? cursorOf(rows[limit - 1]) : null };
  });
}

export async function getInvoice(context, invoiceId) {
  return withTenant(context, async (tx) => {
    const row = await tx.emrInvoice.findFirst({
      where: { organizationId: context.organizationId, id: invoiceId },
      include: { patient: patientSummary, charges: { orderBy: { serviceAt: 'asc' } }, payments: { orderBy: { receivedAt: 'asc' } } },
    });
    if (!row) throw new EmrError('INVOICE_NOT_FOUND');
    const entries = await tx.emrBillingLedger.findMany({ where: { organizationId: context.organizationId, invoiceId }, orderBy: { createdAt: 'asc' } });
    await recordAudit(tx, context, { action: 'invoice.viewed', resourceType: 'invoice', resourceId: invoiceId });
    return { ...toInvoice(row), ledger: entries.map(toLedger) };
  });
}

async function lockInvoice(tx, context, invoiceId) {
  const rows = await tx.$queryRaw`
    SELECT "id" FROM "emr_invoices" WHERE "organization_id" = ${context.organizationId} AND "id" = ${invoiceId} FOR UPDATE`;
  if (!rows.length) throw new EmrError('INVOICE_NOT_FOUND');
  return tx.emrInvoice.findFirst({ where: { organizationId: context.organizationId, id: invoiceId } });
}

const setInvoice = async (tx, context, invoice, data) => {
  const { count } = await tx.emrInvoice.updateMany({ where: { organizationId: context.organizationId, id: invoice.id, version: invoice.version }, data: { ...data, version: { increment: 1 } } });
  if (count !== 1) throw new Error('Invoice changed while locked');
};

/** Voids an unpaid invoice; its charges return to UNBILLED so they can be invoiced again. */
export async function voidInvoice(context, invoiceId, expectedVersion, { reason }) {
  return withTenant(context, async (tx) => {
    const invoice = await lockInvoice(tx, context, invoiceId);
    if (invoice.version !== expectedVersion) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: invoice.version }, headers: { ETag: etagFor(invoice.version) } });
    if (invoice.status === 'VOID') throw new EmrError('INVALID_STATE', { message: 'This invoice is already void.' });
    if (invoice.amountPaidMinor > 0n) throw new EmrError('INVALID_STATE', { message: 'Payments have been made on this invoice; reverse them before voiding it.' });
    await setInvoice(tx, context, invoice, { status: 'VOID', voidedAt: new Date(), voidedByUserId: context.userId, voidReason: reason });
    await tx.emrCharge.updateMany({ where: { organizationId: context.organizationId, invoiceId }, data: { status: 'UNBILLED', invoiceId: null } });
    await ledger(tx, context, invoice, { kind: 'INVOICE_VOIDED', amountMinor: -invoice.totalMinor, balanceAfterMinor: 0n });
    await recordAudit(tx, context, { action: 'invoice.voided', resourceType: 'invoice', resourceId: invoiceId });
    await enqueueEvent(tx, context, { type: 'invoice.voided', aggregateType: 'invoice', aggregateId: invoiceId, data: { patientId: invoice.patientId } });
    return toInvoice(await tx.emrInvoice.findFirst({ where: { organizationId: context.organizationId, id: invoiceId } }));
  });
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------
export async function recordPayment(context, invoiceId, input, { idempotencyKey }) {
  if (!idempotencyKey) throw new EmrError('IDEMPOTENCY_KEY_REQUIRED');
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: `payment:${invoiceId}`, body: input }, async () => {
    const invoice = await lockInvoice(tx, context, invoiceId);
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(invoice.status)) throw new EmrError('INVALID_STATE', { message: `This invoice is ${invoice.status.toLowerCase().replace('_', ' ')}.` });
    const amount = BigInt(input.amountMinor);
    const balance = invoice.totalMinor - invoice.amountPaidMinor;
    if (amount > balance) throw new EmrError('OVERPAYMENT', { details: { balanceMinor: money(balance) } });
    const now = new Date();
    const receiptNumber = numbered('RCPT', now.getUTCFullYear(), await nextSequence(tx, context, `receipt_${now.getUTCFullYear()}`));
    const payment = await tx.emrPayment.create({
      data: {
        organizationId: context.organizationId, invoiceId, patientId: invoice.patientId, receiptNumber, method: input.method,
        amountMinor: amount, reference: input.reference ?? null, receivedByUserId: context.userId, receivedAt: now,
      },
    });
    const paid = invoice.amountPaidMinor + amount;
    await setInvoice(tx, context, invoice, { amountPaidMinor: paid, status: invoiceStatusFor(invoice.totalMinor, paid) });
    await ledger(tx, context, invoice, { kind: 'PAYMENT', amountMinor: -amount, balanceAfterMinor: invoice.totalMinor - paid, paymentId: payment.id });
    await recordAudit(tx, context, { action: 'payment.recorded', resourceType: 'payment', resourceId: payment.id });
    await enqueueEvent(tx, context, { type: 'payment.recorded', aggregateType: 'invoice', aggregateId: invoiceId, data: { patientId: invoice.patientId, paymentId: payment.id } });
    return { statusCode: 201, body: { ...toPayment(payment), invoice: toInvoice(await tx.emrInvoice.findFirst({ where: { organizationId: context.organizationId, id: invoiceId } })) } };
  }));
}

/** Reverses a posted payment (e.g. a bounced transfer or a refund). Never by the person who took it. */
export async function reversePayment(context, paymentId, { reason }) {
  return withTenant(context, async (tx) => {
    const found = await tx.emrPayment.findFirst({ where: { organizationId: context.organizationId, id: paymentId }, select: { invoiceId: true } });
    if (!found) throw new EmrError('PAYMENT_NOT_FOUND');
    const invoice = await lockInvoice(tx, context, found.invoiceId);
    const payment = await tx.emrPayment.findFirst({ where: { organizationId: context.organizationId, id: paymentId } });
    if (payment.status !== 'POSTED') throw new EmrError('INVALID_STATE', { message: 'This payment is already reversed.' });
    if (payment.receivedByUserId === context.userId) throw new EmrError('PERMISSION_DENIED', { message: 'A payment must be reversed by someone other than the person who recorded it.' });
    await tx.emrPayment.updateMany({
      where: { organizationId: context.organizationId, id: paymentId, status: 'POSTED' },
      data: { status: 'REVERSED', reversedAt: new Date(), reversedByUserId: context.userId, reversalReason: reason },
    });
    const paid = invoice.amountPaidMinor - payment.amountMinor;
    await setInvoice(tx, context, invoice, { amountPaidMinor: paid, status: invoiceStatusFor(invoice.totalMinor, paid) });
    await ledger(tx, context, invoice, { kind: 'PAYMENT_REVERSED', amountMinor: payment.amountMinor, balanceAfterMinor: invoice.totalMinor - paid, paymentId });
    await recordAudit(tx, context, { action: 'payment.reversed', resourceType: 'payment', resourceId: paymentId });
    await enqueueEvent(tx, context, { type: 'payment.reversed', aggregateType: 'invoice', aggregateId: invoice.id, data: { patientId: invoice.patientId, paymentId } });
    return toPayment(await tx.emrPayment.findFirst({ where: { organizationId: context.organizationId, id: paymentId } }));
  });
}

// ---------------------------------------------------------------------------------------------
// Statements and reconciliation
// ---------------------------------------------------------------------------------------------
export async function patientStatement(context, patientId) {
  return withTenant(context, async (tx) => {
    const patient = await tx.emrPatient.findFirst({ where: { organizationId: context.organizationId, id: patientId }, select: patientSummary.select });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    const invoices = await tx.emrInvoice.findMany({ where: { organizationId: context.organizationId, patientId, status: { not: 'VOID' } }, orderBy: { issuedAt: 'desc' } });
    const unbilled = await tx.emrCharge.aggregate({ where: { organizationId: context.organizationId, patientId, status: 'UNBILLED' }, _sum: { amountMinor: true, taxMinor: true } });
    await recordAudit(tx, context, { action: 'statement.viewed', resourceType: 'patient', resourceId: patientId });
    const items = invoices.map(toInvoice);
    return {
      patient: { ...patient, dateOfBirth: dateOnly(patient.dateOfBirth) },
      invoices: items,
      outstandingMinor: items.reduce((sum, i) => sum + i.balanceMinor, 0),
      unbilledMinor: money((unbilled._sum.amountMinor ?? 0n) + (unbilled._sum.taxMinor ?? 0n)),
    };
  });
}

/** Every invoice must agree with its charges, its posted payments and its ledger. */
export async function reconciliation(context) {
  return withTenant(context, async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT i."id", i."number", i."status", i."subtotal_minor" AS "subtotal", i."tax_minor" AS "tax",
             i."total_minor" AS "total", i."amount_paid_minor" AS "paid",
             (SELECT COALESCE(SUM(c."amount_minor"), 0) FROM "emr_charges" c WHERE c."organization_id" = i."organization_id" AND c."invoice_id" = i."id") AS "chargesAmount",
             (SELECT COALESCE(SUM(c."tax_minor"), 0) FROM "emr_charges" c WHERE c."organization_id" = i."organization_id" AND c."invoice_id" = i."id") AS "chargesTax",
             (SELECT COALESCE(SUM(p."amount_minor"), 0) FROM "emr_payments" p WHERE p."organization_id" = i."organization_id" AND p."invoice_id" = i."id" AND p."status" = 'POSTED') AS "postedPayments",
             (SELECT COALESCE(SUM(l."amount_minor"), 0) FROM "emr_billing_ledger" l WHERE l."organization_id" = i."organization_id" AND l."invoice_id" = i."id") AS "ledgerBalance"
      FROM "emr_invoices" i WHERE i."organization_id" = ${context.organizationId}`;
    const discrepancies = [];
    for (const r of rows) {
      const n = (v) => BigInt(v);
      const balance = r.status === 'VOID' ? 0n : n(r.total) - n(r.paid);
      const problems = [];
      if (r.status !== 'VOID' && (n(r.chargesAmount) !== n(r.subtotal) || n(r.chargesTax) !== n(r.tax))) problems.push('CHARGES');
      if (n(r.postedPayments) !== n(r.paid)) problems.push('PAYMENTS');
      if (n(r.ledgerBalance) !== balance) problems.push('LEDGER');
      if (problems.length) discrepancies.push({ invoiceId: r.id, number: r.number, problems });
    }
    return { invoicesChecked: rows.length, balanced: discrepancies.length === 0, discrepancies };
  });
}
