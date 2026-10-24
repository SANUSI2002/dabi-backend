// Receivables: customers, quotations, sales orders, invoices, receipts, credit notes, cash-sale and refund
// receipts, delayed charges, revenue recognition, recurring invoices, FX revaluation, reminders, statements.
//
// Rules enforced here:
//   - an issued document posts its journal entry through the ledger (balanced, outside locked periods);
//     an invoice credits each line's revenue account (or Deferred Revenue when recognised over time) and
//     each tax's liability account; voiding reverses the entry, and only an unpaid invoice can be voided;
//   - a receipt can only settle the customer's own open invoices, never more than their balance, and an
//     early-payment discount only within its term; foreign settlements book the realised FX gain or loss;
//   - a credit note is applied to the same customer's invoices, never beyond what is left of either;
//   - a customer on credit hold cannot be invoiced; going over the credit limit needs approval (acct.approve);
//   - invoices, reminders and statements are recorded, and emailed to the customer with the invoice or the
//     statement attached as a PDF when it has an email address and an email provider is configured (each
//     notice says whether it was emailed); only an issued invoice is emailed;
//   - acct.view reads, acct.post prepares and issues, acct.control changes credit limits and holds.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { postEntry, requireAcct, reverseInTx, round2 } from '../ledger/ledger.service.js';
import { docSubtotal, docTax, docTaxBreakdown, docTotal, dueDateFor, ensureSettings, lineAmount, nextDocNumber, taxRates } from '../settings/settings.service.js';
import { timeLinesForInvoice } from '../projects/projects.service.js';
import { queueCustomerEmail, senderFor } from '../email/customerEmail.js';
import { customerStatementInTx, invoicePdfInTx, statementPdf } from '../documents/documents.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const can = (context, p) => context.permissions.includes(p) || context.permissions.includes('acct.control');
const notFound = (what = 'Record') => new EmrError('HR_RECORD_NOT_FOUND', { message: `${what} not found.` });
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
const ACCT = { arPatients: 1100, arNhis: 1110, arHmo: 1120, discounts: 4900, fxGain: 4110, fxLoss: 5610, deferred: 2400, openingEquity: 3900, consultation: 4000 };
const arAccountFor = (type) => (type === 'NHIS' ? ACCT.arNhis : type === 'HMO' ? ACCT.arHmo : ACCT.arPatients);
const monthsAdd = (d, m) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, d.getUTCDate(), 12));
const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const OPEN = ['Open', 'Partially Paid'];
const uuidish = () => Math.random().toString(36).slice(2, 10);

// ---- shared helpers ---------------------------------------------------------------------------------
export async function customerOf(tx, context, id) {
  const c = await tx.acctCustomer.findFirst({ where: { ...org(context), id } });
  if (!c) throw notFound('Customer');
  return c;
}
export async function docOf(tx, context, id, kind) {
  const d = await tx.acctSalesDoc.findFirst({ where: { ...org(context), id, kind } });
  if (!d) throw notFound({ estimate: 'Quotation', 'sales-order': 'Sales order', invoice: 'Invoice', 'credit-note': 'Credit note', 'sales-receipt': 'Sales receipt', 'refund-receipt': 'Refund receipt' }[kind]);
  return d;
}
/** Lines as the screens send them, checked: real accounts, real taxes, a quantity and a price. */
async function cleanLines(tx, context, lines, rates) {
  if (!lines.length) throw new EmrError('VALIDATION_FAILED', { message: 'Add at least one line.' });
  const accounts = new Map((await tx.acctAccount.findMany({ where: { ...org(context), number: { in: [...new Set(lines.map((l) => l.accountNumber))] } } })).map((a) => [a.number, a]));
  return lines.map((l) => {
    const a = accounts.get(l.accountNumber);
    if (!a || !a.isActive) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${l.accountNumber} is not available.` });
    for (const id of [...(l.taxRateIds ?? []), ...(l.taxRateId ? [l.taxRateId] : [])]) if (!rates.has(id)) throw new EmrError('VALIDATION_FAILED', { message: `Unknown tax rate ${id}.` });
    return { id: l.id ?? `sl-${uuidish()}`, accountNumber: l.accountNumber, description: l.description, qty: l.qty, unitPrice: l.unitPrice, ...(l.taxRateId ? { taxRateId: l.taxRateId } : {}), ...(l.taxRateIds?.length ? { taxRateIds: l.taxRateIds } : {}) };
  });
}
const total = (rates, d) => docTotal(rates, d.lines);
const balanceOf = (rates, inv) => round2(total(rates, inv) - Number(inv.amountPaid));
const balanceNgn = (rates, inv) => round2(balanceOf(rates, inv) * Number(inv.exchangeRate));
const statusAfterPayment = (rates, inv, paid) => (paid >= total(rates, inv) - 0.01 ? 'Paid' : paid > 0.01 ? 'Partially Paid' : 'Open');
const shownStatus = (status, dueDate) => (OPEN.includes(status) && dueDate && dueDate < new Date() ? 'Overdue' : status);

async function customerBalance(tx, context, rates, customerId) {
  const open = await tx.acctSalesDoc.findMany({ where: { ...org(context), kind: 'invoice', customerId, status: { in: OPEN } } });
  return round2(open.reduce((n, i) => n + balanceNgn(rates, i), 0));
}

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    await ensureSettings(tx, context);
    const [customers, docs, receipts, applications, schedules, charges, notices, emails] = await Promise.all([
      tx.acctCustomer.findMany({ where: org(context), orderBy: { name: 'asc' } }),
      tx.acctSalesDoc.findMany({ where: org(context), orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }] }),
      tx.acctReceipt.findMany({ where: { ...org(context), voidedAt: null }, orderBy: { receiptDate: 'desc' } }),
      tx.acctCreditApplication.findMany({ where: org(context), orderBy: { appliedAt: 'asc' } }),
      tx.acctRevenueSchedule.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }),
      tx.acctDelayedCharge.findMany({ where: { ...org(context), removedAt: null }, orderBy: { chargeDate: 'desc' } }),
      tx.acctCustomerNotice.findMany({ where: org(context), orderBy: { sentAt: 'desc' } }),
      tx.acctEmailJob.findMany({ where: org(context), select: { noticeId: true, status: true, sentAt: true, lastError: true } }),
    ]);
    const names = await userNameMap(tx, [...docs.map((d) => d.createdByUserId), ...receipts.map((r) => r.createdByUserId), ...notices.map((n) => n.sentByUserId)]);
    // whether each notice reached the customer by email
    const emailByNotice = new Map(emails.map((e) => [e.noticeId, e]));
    const emailOf = (n) => {
      const e = emailByNotice.get(n.id);
      if (!e) return { status: n.sentTo ? 'NOT_SENT' : 'NO_EMAIL_ADDRESS' };
      return { status: e.status, ...(e.sentAt ? { sentAt: iso(e.sentAt) } : {}), ...(e.status === 'FAILED' ? { error: e.lastError } : {}) };
    };
    const who = (id) => names.get(id) ?? 'Former member';
    const iso = (d) => (d ? d.toISOString() : undefined);
    const base = (d) => ({ id: d.id, number: d.number, customerId: d.customerId ?? undefined, date: iso(d.docDate), lines: d.lines, notes: d.notes ?? undefined, journalEntryId: d.journalEntryId ?? undefined, createdBy: who(d.createdByUserId), createdAt: d.createdAt, version: d.version });
    const of = (kind) => docs.filter((d) => d.kind === kind);
    const scheduleOf = new Map(schedules.map((s) => [s.invoiceId, s.id]));
    return {
      customers: customers.map((c) => ({
        id: c.id, name: c.name, type: c.type, email: c.email ?? undefined, phone: c.phone ?? undefined, address: c.address ?? undefined, city: c.city ?? undefined, arAccountNumber: c.arAccountNumber,
        currency: c.currency, paymentTermsDays: c.paymentTermsDays, paymentTermId: c.paymentTermId ?? undefined, creditLimit: Number(c.creditLimit), creditHold: c.creditHold, openingBalance: 0, createdAt: c.createdAt, version: c.version,
      })),
      estimates: of('estimate').map((d) => ({ ...base(d), expiryDate: iso(d.expiryDate), status: d.status, convertedToOrderId: d.convertedToId ?? undefined, convertedToInvoiceId: d.convertedToInvoiceId ?? undefined })),
      salesOrders: of('sales-order').map((d) => ({ ...base(d), estimateId: d.sourceDocId ?? undefined, status: d.status, invoiceId: d.convertedToInvoiceId ?? undefined })),
      invoices: of('invoice').map((d) => ({
        ...base(d), salesOrderId: d.sourceDocId ?? undefined, dueDate: iso(d.dueDate), status: shownStatus(d.status, d.dueDate), amountPaid: Number(d.amountPaid), currency: d.currency, exchangeRate: Number(d.exchangeRate),
        issuedAt: iso(d.issuedAt), source: d.source === 'EMR Billing' ? 'EMR Billing' : 'Manual', emrInvoiceId: d.source === 'EMR Billing' ? d.sourceRef ?? undefined : undefined, projectId: d.projectId ?? undefined,
        revenueScheduleId: scheduleOf.get(d.id), ...(d.recurEveryMonths ? { isRecurring: true, recurringTemplate: false, recurrenceEveryMonths: d.recurEveryMonths, recurrenceNextDate: iso(d.recurNextDate), recurrenceEndDate: iso(d.recurEndDate) } : {}),
      })),
      receipts: receipts.map((r) => ({
        id: r.id, number: r.number, customerId: r.customerId, date: iso(r.receiptDate), method: r.method, depositAccountNumber: r.depositAccountNumber, amount: Number(r.amount), allocations: r.allocations,
        settlementRate: r.settlementRate === null ? undefined : Number(r.settlementRate), reference: r.reference ?? undefined, notes: r.notes ?? undefined, journalEntryId: r.journalEntryId, createdBy: who(r.createdByUserId), createdAt: r.createdAt,
      })),
      creditNotes: of('credit-note').map((d) => ({
        ...base(d), invoiceId: d.sourceDocId ?? undefined, reason: d.reason ?? '', status: d.status, refundedAmount: Number(d.refundedAmount),
        applications: applications.filter((a) => a.creditNoteId === d.id && a.kind === 'apply').map((a) => ({ invoiceId: a.invoiceId, amount: Number(a.amount), date: iso(a.appliedAt) })),
      })),
      salesReceipts: of('sales-receipt').map((d) => ({ ...base(d), customerName: d.customerName ?? undefined, method: d.method, depositAccountNumber: d.cashAccountNumber, status: d.status })),
      refundReceipts: of('refund-receipt').map((d) => ({ ...base(d), method: d.method, fromAccountNumber: d.cashAccountNumber, reason: d.reason ?? '', status: d.status })),
      revenueSchedules: schedules.map((s) => ({ id: s.id, invoiceId: s.invoiceId, customerId: s.customerId, totalAmount: Number(s.totalAmount), method: 'Straight Line', startPeriod: s.startPeriod, months: s.months, deferredAccountNumber: s.deferredAccountNumber, revenueAccountNumber: s.revenueAccountNumber, entries: s.entries, createdAt: s.createdAt, version: s.version })),
      delayedCharges: charges.map((c) => ({ id: c.id, customerId: c.customerId, date: iso(c.chargeDate), accountNumber: c.accountNumber, description: c.description, qty: Number(c.qty), unitPrice: Number(c.unitPrice), taxRateId: c.taxRateId ?? undefined, status: c.status, invoiceId: c.invoiceId ?? undefined, createdBy: who(c.createdByUserId), createdAt: c.createdAt })),
      reminders: notices.filter((n) => n.kind === 'reminder').map((n) => ({ invoiceId: n.invoiceId, level: n.level, tone: n.tone, sentAt: iso(n.sentAt), sentBy: who(n.sentByUserId), email: emailOf(n) })),
      statementLog: notices.filter((n) => n.kind === 'statement').map((n) => ({ customerId: n.customerId, to: n.sentTo, sentAt: iso(n.sentAt), by: who(n.sentByUserId), email: emailOf(n) })),
      invoiceEmails: notices.filter((n) => n.kind === 'invoice').map((n) => ({ invoiceId: n.invoiceId, customerId: n.customerId, to: n.sentTo, sentAt: iso(n.sentAt), by: who(n.sentByUserId), email: emailOf(n) })),
    };
  });
}

// ---- customers --------------------------------------------------------------------------------------
export async function addCustomerInTx(tx, context, c) {
  const settings = await ensureSettings(tx, context);
  if (c.paymentTermId && !settings.paymentTerms.some((t) => t.id === c.paymentTermId)) throw new EmrError('VALIDATION_FAILED', { message: 'Unknown payment term.' });
  const row = await tx.acctCustomer.create({
    data: {
      ...(c.id ? { id: c.id } : {}), ...org(context), name: c.name, type: c.type, email: c.email ?? null, phone: c.phone ?? null, address: c.address ?? null, city: c.city ?? null,
      arAccountNumber: arAccountFor(c.type), currency: c.currency ?? 'NGN', paymentTermsDays: c.paymentTermsDays ?? 30, paymentTermId: c.paymentTermId ?? null, creditLimit: c.creditLimit ?? 0,
    },
  });
  // An opening balance is a real journal entry: the customer's receivable against Opening Balance Equity.
  if ((c.openingBalance ?? 0) > 0) {
    const ledger = await tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } });
    await postEntry(tx, context, {
      date: ledger.booksLockedBefore ?? new Date(), source: 'Opening Balance', memo: `Opening AR balance — ${c.name}`, skipLock: true,
      lines: [{ accountNumber: row.arAccountNumber, debit: c.openingBalance, credit: 0, customerId: row.id }, { accountNumber: ACCT.openingEquity, debit: 0, credit: c.openingBalance }],
    });
  }
  await audited(tx, context, 'customer.created', 'customer', row.id);
  return row;
}
export async function addCustomer(context, input) {
  requireAcct(context, 'acct.post');
  if (input.creditLimit && !can(context, 'acct.approve')) throw new EmrError('PERMISSION_DENIED', { message: 'Setting a credit limit needs approval rights.' });
  return withTenant(context, async (tx) => ({ id: (await addCustomerInTx(tx, context, input)).id }));
}
export async function importCustomers(context, rows) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    let added = 0;
    for (const r of rows) { await addCustomerInTx(tx, context, { ...r, creditLimit: can(context, 'acct.approve') ? r.creditLimit : 0 }); added += 1; }
    return { added, errors: [] };
  });
}
export async function updateCustomer(context, id, expectedVersion, patch) {
  const creditOnly = Object.keys(patch).every((k) => ['creditLimit', 'creditHold'].includes(k));
  // Credit limits and holds are an approver's call; everything else is the preparer's.
  if (!creditOnly) requireAcct(context, 'acct.post');
  if ((patch.creditLimit !== undefined || patch.creditHold !== undefined) && !can(context, 'acct.approve')) throw new EmrError('PERMISSION_DENIED', { message: 'Changing credit limits or holds needs approval rights.' });
  return withTenant(context, async (tx) => {
    const c = await customerOf(tx, context, id);
    const data = Object.fromEntries(Object.entries({ ...patch, ...(patch.type && patch.type !== c.type ? { arAccountNumber: arAccountFor(patch.type) } : {}) }).filter(([, v]) => v !== undefined));
    if (data.arAccountNumber && (await customerBalance(tx, context, await taxRates(tx, context), id)) > 0) throw new EmrError('INVALID_STATE', { message: 'Settle the open invoices before changing the customer type (its receivable account changes).' });
    await updateVersioned(tx.acctCustomer, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'customer.updated', 'customer', id, Object.keys(data));
    return { id };
  });
}

// ---- quotations and sales orders --------------------------------------------------------------------
export async function createDoc(tx, context, kind, fields) {
  const number = await nextDocNumber(tx, context, kind);
  try {
    return await tx.acctSalesDoc.create({ data: { ...org(context), kind, number, createdByUserId: context.userId, ...fields } });
  } catch (error) { throw uniqueViolation(error, { pkey: 'HR_CODE_IN_USE', number_key: 'HR_CODE_IN_USE' }) ?? error; }
}
export async function changeDoc(tx, context, d, data, action) {
  await updateVersioned(tx.acctSalesDoc, { organizationId: context.organizationId, id: d.id, expectedVersion: d.version, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
  await audited(tx, context, action, d.kind.replace('-', '_'), d.id, Object.keys(data));
}
export async function createEstimate(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await customerOf(tx, context, input.customerId);
    const lines = await cleanLines(tx, context, input.lines, await taxRates(tx, context));
    const date = new Date(input.date);
    const d = await createDoc(tx, context, 'estimate', { ...(input.id ? { id: input.id } : {}), customerId: input.customerId, docDate: date, expiryDate: new Date(date.getTime() + input.expiryDays * 86_400_000), lines, notes: input.notes ?? null, status: 'Draft' });
    await audited(tx, context, 'estimate.created', 'estimate', d.id);
    return { id: d.id, number: d.number };
  });
}
export async function updateDraftDoc(context, kind, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const d = await docOf(tx, context, id, kind);
    if (d.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft can be edited.' });
    if (d.version !== expectedVersion) throw new EmrError('VERSION_CONFLICT');
    const data = Object.fromEntries(Object.entries({
      docDate: patch.date ? new Date(patch.date) : undefined, dueDate: patch.dueDate ? new Date(patch.dueDate) : undefined, expiryDate: patch.expiryDate ? new Date(patch.expiryDate) : undefined,
      lines: patch.lines ? await cleanLines(tx, context, patch.lines, await taxRates(tx, context)) : undefined, notes: patch.notes,
    }).filter(([, v]) => v !== undefined));
    await changeDoc(tx, context, d, data, `${kind}.updated`);
    return { id };
  });
}
const ESTIMATE_MOVES = { Draft: ['Sent', 'Declined'], Sent: ['Accepted', 'Declined', 'Expired'], Accepted: ['Declined'] };
export async function setEstimateStatus(context, id, { status }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const d = await docOf(tx, context, id, 'estimate');
    if (!(ESTIMATE_MOVES[d.status] ?? []).includes(status)) throw new EmrError('INVALID_STATE', { message: `A ${d.status.toLowerCase()} quotation cannot be marked ${status.toLowerCase()}.` });
    await changeDoc(tx, context, d, { status }, `estimate.${status.toLowerCase()}`);
    return { id, status };
  });
}
export async function createSalesOrder(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await customerOf(tx, context, input.customerId);
    const lines = await cleanLines(tx, context, input.lines, await taxRates(tx, context));
    const d = await createDoc(tx, context, 'sales-order', { ...(input.id ? { id: input.id } : {}), customerId: input.customerId, docDate: new Date(input.date), lines, notes: input.notes ?? null, status: 'Draft' });
    await audited(tx, context, 'sales_order.created', 'sales_order', d.id);
    return { id: d.id, number: d.number };
  });
}
export async function setOrderStatus(context, id, { status }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const d = await docOf(tx, context, id, 'sales-order');
    const allowed = status === 'Confirmed' ? d.status === 'Draft' : ['Draft', 'Confirmed'].includes(d.status);
    if (!allowed) throw new EmrError('INVALID_STATE', { message: `A ${d.status.toLowerCase()} order cannot be ${status.toLowerCase()}.` });
    await changeDoc(tx, context, d, { status }, `sales_order.${status.toLowerCase()}`);
    return { id, status };
  });
}

// ---- invoices ---------------------------------------------------------------------------------------
export async function createInvoiceInTx(tx, context, input) {
  const settings = await ensureSettings(tx, context);
  const rates = await taxRates(tx, context);
  const cust = await customerOf(tx, context, input.customerId);
  const charges = input.delayedChargeIds?.length ? await tx.acctDelayedCharge.findMany({ where: { ...org(context), id: { in: input.delayedChargeIds }, customerId: cust.id, status: 'Unbilled', removedAt: null } }) : [];
  if (charges.length !== (input.delayedChargeIds?.length ?? 0)) throw new EmrError('INVALID_STATE', { message: 'Some of those charges are already billed or belong to another customer.' });
  const lines = await cleanLines(tx, context, [
    ...input.lines,
    ...charges.map((c) => ({ accountNumber: c.accountNumber, description: c.description, qty: Number(c.qty), unitPrice: Number(c.unitPrice), ...(c.taxRateId ? { taxRateId: c.taxRateId } : {}) })),
    ...(input.timeEntryIds?.length ? await timeLinesForInvoice(tx, context, { customerId: cust.id, timeEntryIds: input.timeEntryIds }) : []),
  ], rates);
  const currency = input.currency ?? cust.currency ?? 'NGN';
  const ledger = await tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } });
  const rate = currency === 'NGN' ? 1 : input.exchangeRate ?? ledger.fxRates.find((r) => r.code === currency)?.rateToNgn;
  if (!rate) throw new EmrError('VALIDATION_FAILED', { message: `No exchange rate is set for ${currency}.` });
  const date = new Date(input.date);
  const inv = await createDoc(tx, context, 'invoice', {
    ...(input.id ? { id: input.id } : {}), customerId: cust.id, sourceDocId: input.salesOrderId ?? null, docDate: date,
    dueDate: input.dueDate ? new Date(input.dueDate) : dueDateFor(settings, date, cust.paymentTermId, cust.paymentTermsDays), lines, notes: input.notes ?? null, status: 'Draft',
    currency, exchangeRate: rate, source: input.source ?? 'Manual', sourceRef: input.sourceRef ?? null, projectId: input.projectId ?? null,
    ...(input.recurEveryMonths ? { recurEveryMonths: input.recurEveryMonths, recurNextDate: monthsAdd(date, input.recurEveryMonths), recurEndDate: input.recurEndDate ? new Date(input.recurEndDate) : null } : {}),
  });
  if (charges.length) await tx.acctDelayedCharge.updateMany({ where: { ...org(context), id: { in: charges.map((c) => c.id) } }, data: { status: 'Invoiced', invoiceId: inv.id } });
  if (input.timeEntryIds?.length) await tx.acctTimeEntry.updateMany({ where: { ...org(context), id: { in: input.timeEntryIds } }, data: { status: 'Invoiced', invoiceId: inv.id } });
  // Revenue recognised over several months: the invoice credits Deferred Revenue, released month by month.
  const months = input.deferOverMonths ?? 0;
  if (months > 1) {
    const net = round2(docSubtotal(lines) * rate);
    const per = round2(net / months);
    await tx.acctRevenueSchedule.create({
      data: {
        ...org(context), invoiceId: inv.id, customerId: cust.id, totalAmount: net, startPeriod: ym(date), months, deferredAccountNumber: ACCT.deferred, revenueAccountNumber: lines[0]?.accountNumber ?? ACCT.consultation,
        entries: Array.from({ length: months }, (_, i) => ({ id: `rse-${uuidish()}`, period: ym(monthsAdd(date, i)), amount: i === months - 1 ? round2(net - per * (months - 1)) : per, recognized: false })),
      },
    });
  }
  await audited(tx, context, 'invoice.created', 'invoice', inv.id);
  return inv;
}
export async function createInvoice(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const inv = await createInvoiceInTx(tx, context, input);
    return { id: inv.id, number: inv.number };
  });
}
/** Converts a quotation or sales order into a draft invoice (or an order), marking the source converted. */
export async function convertDoc(context, kind, id, { to, newId }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const src = await docOf(tx, context, id, kind);
    const ok = kind === 'estimate' ? ['Draft', 'Sent', 'Accepted'].includes(src.status) : src.status === 'Confirmed' || src.status === 'Draft';
    if (!ok) throw new EmrError('INVALID_STATE', { message: `This ${kind === 'estimate' ? 'quotation' : 'order'} has already been converted or closed.` });
    let target;
    if (to === 'sales-order') {
      if (kind !== 'estimate') throw new EmrError('VALIDATION_FAILED', { message: 'Only a quotation becomes an order.' });
      target = await createDoc(tx, context, 'sales-order', { ...(newId ? { id: newId } : {}), customerId: src.customerId, sourceDocId: src.id, docDate: new Date(), lines: src.lines, notes: src.notes, status: 'Draft' });
      await changeDoc(tx, context, src, { status: 'Converted', convertedToId: target.id }, 'estimate.converted');
    } else {
      target = await createInvoiceInTx(tx, context, { id: newId, customerId: src.customerId, date: new Date(), lines: src.lines, notes: src.notes ?? undefined, salesOrderId: kind === 'sales-order' ? src.id : undefined });
      await changeDoc(tx, context, src, { status: 'Converted', convertedToInvoiceId: target.id }, `${kind.replace('-', '_')}.converted`);
    }
    return { id: target.id };
  });
}

async function postInvoiceEntry(tx, context, rates, inv, cust, schedule) {
  const rate = Number(inv.exchangeRate);
  const gross = round2(total(rates, inv) * rate);
  const tax = round2(docTax(rates, inv.lines) * rate);
  const net = round2(gross - tax);
  const suffix = inv.currency !== 'NGN' ? ` (${inv.currency} ${total(rates, inv).toLocaleString('en-NG')} @ ${rate})` : '';
  const lines = [{ accountNumber: cust.arAccountNumber, debit: gross, credit: 0, description: `${inv.number} — ${cust.name}${suffix}`, customerId: cust.id }];
  if (schedule) lines.push({ accountNumber: schedule.deferredAccountNumber, debit: 0, credit: net, description: `Deferred revenue — ${inv.number}`, customerId: cust.id, projectId: inv.projectId ?? undefined });
  else for (const l of inv.lines) {
    // a negative line (a discount carried over from EMR billing) is a debit to its contra-revenue account
    const amt = round2(lineAmount(l) * rate);
    lines.push({ accountNumber: l.accountNumber, debit: amt < 0 ? -amt : 0, credit: amt > 0 ? amt : 0, description: l.description, customerId: cust.id, projectId: inv.projectId ?? undefined });
  }
  for (const b of docTaxBreakdown(rates, inv.lines)) if (b.amount > 0) lines.push({ accountNumber: b.accountNumber, debit: 0, credit: round2(b.amount * rate), description: `Output ${b.label} — ${inv.number}`, customerId: cust.id });
  // rounding across lines: settle any kobo difference on the receivable line so the entry balances
  const credits = round2(lines.slice(1).reduce((n, l) => n + l.credit - l.debit, 0));
  lines[0].debit = credits;
  return postEntry(tx, context, { date: inv.docDate, source: 'Invoice', memo: `Invoice ${inv.number} — ${cust.name}`, reference: inv.number, lines });
}
export async function issueInvoiceInTx(tx, context, id, { overrideCredit = false } = {}) {
  const rates = await taxRates(tx, context);
  const inv = await docOf(tx, context, id, 'invoice');
  if (inv.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft invoice can be issued.' });
  if (!inv.lines.length || total(rates, inv) <= 0) throw new EmrError('VALIDATION_FAILED', { message: 'Add at least one line with an amount.' });
  const cust = await customerOf(tx, context, inv.customerId);
  if (cust.creditHold) throw new EmrError('INVALID_STATE', { message: `${cust.name} is on credit hold. Release the hold before issuing.` });
  let warning;
  if (Number(cust.creditLimit) > 0) {
    const projected = round2((await customerBalance(tx, context, rates, cust.id)) + balanceNgn(rates, inv));
    if (projected > Number(cust.creditLimit)) {
      warning = `Issuing this puts ${cust.name} at ${projected.toLocaleString('en-NG')} against a ${Number(cust.creditLimit).toLocaleString('en-NG')} limit.`;
      if (!overrideCredit) throw new EmrError('INVALID_STATE', { message: warning });
      if (!can(context, 'acct.approve')) throw new EmrError('PERMISSION_DENIED', { message: 'Going over a credit limit needs approval rights.' });
    }
  }
  const schedule = await tx.acctRevenueSchedule.findFirst({ where: { ...org(context), invoiceId: id } });
  const entry = await postInvoiceEntry(tx, context, rates, inv, cust, schedule);
  await changeDoc(tx, context, inv, { status: 'Open', journalEntryId: entry.id, issuedAt: new Date() }, warning ? 'invoice.issued_over_limit' : 'invoice.issued');
  return { id, journalEntryId: entry.id, creditWarning: warning };
}
export async function issueInvoice(context, id, opts) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => issueInvoiceInTx(tx, context, id, opts));
}
export async function voidDoc(context, kind, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, (tx) => voidDocInTx(tx, context, kind, id));
}
export async function voidDocInTx(tx, context, kind, id) {
  const d = await docOf(tx, context, id, kind);
  if (d.status === 'Void') throw new EmrError('INVALID_STATE', { message: 'Already void.' });
  if (kind === 'invoice' && Number(d.amountPaid) > 0) throw new EmrError('INVALID_STATE', { message: 'Un-apply receipts and credit notes before voiding.' });
  if (kind === 'invoice' && d.source === 'Payer Bill') throw new EmrError('INVALID_STATE', { message: 'This invoice bills a patient\'s charges to their payer: reverse the transfer instead of voiding it.' });
  if (d.journalEntryId) await reverseInTx(tx, context, d.journalEntryId, { memo: `Void ${kind.replace('-', ' ')} ${d.number}` });
  await changeDoc(tx, context, d, { status: 'Void' }, `${kind.replace('-', '_')}.voided`);
  if (kind === 'invoice') await tx.acctDelayedCharge.updateMany({ where: { ...org(context), invoiceId: id }, data: { status: 'Unbilled', invoiceId: null } });
  if (kind === 'invoice') await tx.acctTimeEntry.updateMany({ where: { ...org(context), invoiceId: id }, data: { status: 'Unbilled', invoiceId: null } }); // the time can be billed again
  return { id, status: 'Void' };
}

// ---- receipts ---------------------------------------------------------------------------------------
async function discountAllowed(tx, context, rates, inv, cust, date) {
  const settings = await ensureSettings(tx, context);
  const term = settings.paymentTerms.find((t) => t.id === cust.paymentTermId);
  if (!term?.discountPercent || !term.discountDays) return 0;
  if (date.getTime() > inv.docDate.getTime() + term.discountDays * 86_400_000) return 0;
  return round2(balanceOf(rates, inv) * (term.discountPercent / 100));
}
export async function recordReceipt(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, (tx) => recordReceiptInTx(tx, context, input));
}
export async function recordReceiptInTx(tx, context, input) {
  const rates = await taxRates(tx, context);
  const cust = await customerOf(tx, context, input.customerId);
  const date = new Date(input.date);
  const depositAcct = await tx.acctAccount.findFirst({ where: { ...org(context), number: input.depositAccountNumber } });
  if (!depositAcct || !['cash', 'bank', 'current_asset'].includes(depositAcct.subtype)) throw new EmrError('VALIDATION_FAILED', { message: 'Deposit into a cash, bank or undeposited-funds account.' });
  const allocations = input.allocations.filter((a) => a.amount > 0 || (a.discount ?? 0) > 0);
  const invoices = new Map();
  let arReliefNgn = 0; let fxDiff = 0; let bankFromAlloc = 0; let discountNgn = 0;
  for (const a of allocations) {
    const inv = await docOf(tx, context, a.invoiceId, 'invoice');
    if (inv.customerId !== cust.id) throw new EmrError('VALIDATION_FAILED', { message: `${inv.number} belongs to another customer.` });
    if (!OPEN.includes(inv.status)) throw new EmrError('INVALID_STATE', { message: `${inv.number} is not open for payment.` });
    const disc = a.discount ?? 0;
    if (disc > 0 && disc > (await discountAllowed(tx, context, rates, inv, cust, date)) + 0.01) throw new EmrError('VALIDATION_FAILED', { message: `No early-payment discount of that size is due on ${inv.number}.` });
    if (a.amount + disc > balanceOf(rates, inv) + 0.01) throw new EmrError('VALIDATION_FAILED', { message: `That is more than the ${balanceOf(rates, inv).toLocaleString('en-NG')} left on ${inv.number}.` });
    const bookRate = Number(inv.exchangeRate);
    const setRate = inv.currency !== 'NGN' ? input.settlementRate ?? bookRate : 1;
    arReliefNgn += (a.amount + disc) * bookRate;
    discountNgn += disc * bookRate;
    fxDiff += a.amount * (setRate - bookRate);
    bankFromAlloc += a.amount * setRate;
    invoices.set(inv.id, { inv, paid: round2(Number(inv.amountPaid) + a.amount + disc) });
  }
  const unallocated = round2(input.amount - bankFromAlloc);
  if (unallocated < -0.01) throw new EmrError('VALIDATION_FAILED', { message: 'The receipt is less than the amounts applied to invoices.' });
  fxDiff = round2(fxDiff); discountNgn = round2(discountNgn);
  const lines = [{ accountNumber: input.depositAccountNumber, debit: input.amount, credit: 0, description: `${input.method} — ${cust.name}` }];
  if (discountNgn > 0.005) lines.push({ accountNumber: ACCT.discounts, debit: discountNgn, credit: 0, description: 'Early-payment discount', customerId: cust.id });
  lines.push({ accountNumber: cust.arAccountNumber, debit: 0, credit: round2(arReliefNgn + Math.max(unallocated, 0)), description: `Applied to ${allocations.length} invoice(s)`, customerId: cust.id });
  if (fxDiff > 0.005) lines.push({ accountNumber: ACCT.fxGain, debit: 0, credit: fxDiff, description: 'Realised FX gain on settlement' });
  else if (fxDiff < -0.005) lines.push({ accountNumber: ACCT.fxLoss, debit: -fxDiff, credit: 0, description: 'Realised FX loss on settlement' });
  const number = await nextDocNumber(tx, context, 'receipt');
  const entry = await postEntry(tx, context, { date, source: 'Customer Payment', memo: `Receipt ${number} — ${cust.name}`, reference: number, lines });
  const r = await tx.acctReceipt.create({
    data: {
      ...(input.id ? { id: input.id } : {}), ...org(context), number, customerId: cust.id, receiptDate: date, method: input.method, depositAccountNumber: input.depositAccountNumber, amount: input.amount,
      allocations, settlementRate: input.settlementRate ?? null, reference: input.reference ?? null, notes: input.notes ?? null, journalEntryId: entry.id, createdByUserId: context.userId,
    },
  });
  for (const { inv, paid } of invoices.values()) await changeDoc(tx, context, inv, { amountPaid: paid, status: statusAfterPayment(rates, inv, paid) }, 'invoice.payment_applied');
  await audited(tx, context, 'receipt.recorded', 'receipt', r.id);
  return { id: r.id, number };
}
/** Voids a receipt whose payment was reversed at source: its entry is reversed and the invoices reopen. */
export async function voidReceiptInTx(tx, context, id, memo) {
  const rates = await taxRates(tx, context);
  const r = await tx.acctReceipt.findFirst({ where: { ...org(context), id } });
  if (!r) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Receipt not found.' });
  if (r.voidedAt) return { id };
  await reverseInTx(tx, context, r.journalEntryId, { memo });
  for (const a of r.allocations) {
    const inv = await docOf(tx, context, a.invoiceId, 'invoice');
    const paid = Math.max(0, round2(Number(inv.amountPaid) - a.amount - (a.discount ?? 0)));
    await changeDoc(tx, context, inv, { amountPaid: paid, status: statusAfterPayment(rates, inv, paid) }, 'invoice.payment_reversed');
  }
  await tx.acctReceipt.updateMany({ where: { ...org(context), id }, data: { voidedAt: new Date() } });
  await audited(tx, context, 'receipt.voided', 'receipt', id);
  return { id };
}

// ---- credit notes -----------------------------------------------------------------------------------
export async function createCreditNote(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const cust = await customerOf(tx, context, input.customerId);
    if (input.invoiceId && (await docOf(tx, context, input.invoiceId, 'invoice')).customerId !== cust.id) throw new EmrError('VALIDATION_FAILED', { message: 'That invoice belongs to another customer.' });
    const lines = await cleanLines(tx, context, input.lines, rates);
    const cn = await createDoc(tx, context, 'credit-note', { ...(input.id ? { id: input.id } : {}), customerId: cust.id, sourceDocId: input.invoiceId ?? null, docDate: new Date(input.date), lines, reason: input.reason, notes: input.notes ?? null, status: 'Open' });
    const jl = [
      ...lines.map((l) => ({ accountNumber: l.accountNumber, debit: lineAmount(l), credit: 0, description: l.description, customerId: cust.id })),
      ...docTaxBreakdown(rates, lines).filter((b) => b.amount > 0).map((b) => ({ accountNumber: b.accountNumber, debit: b.amount, credit: 0, description: `${b.label} adjustment — ${cn.number}`, customerId: cust.id })),
    ];
    jl.push({ accountNumber: cust.arAccountNumber, debit: 0, credit: round2(jl.reduce((n, l) => n + l.debit, 0)), description: `${cn.number} — ${cust.name}`, customerId: cust.id });
    const entry = await postEntry(tx, context, { date: cn.docDate, source: 'Credit Note', memo: `Credit note ${cn.number} — ${cust.name}`, reference: cn.number, lines: jl });
    await tx.acctSalesDoc.updateMany({ where: { ...org(context), id: cn.id }, data: { journalEntryId: entry.id } });
    await audited(tx, context, 'credit_note.issued', 'credit_note', cn.id);
    return { id: cn.id, number: cn.number };
  });
}
async function creditLeft(tx, context, rates, cn) {
  const used = await tx.acctCreditApplication.aggregate({ where: { ...org(context), creditNoteId: cn.id }, _sum: { amount: true } });
  return round2(total(rates, cn) - Number(used._sum.amount ?? 0));
}
export async function applyCreditNote(context, id, { invoiceId, amount }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const cn = await docOf(tx, context, id, 'credit-note');
    const inv = await docOf(tx, context, invoiceId, 'invoice');
    if (!['Open', 'Partially Applied'].includes(cn.status)) throw new EmrError('INVALID_STATE', { message: 'This credit note has nothing left to apply.' });
    if (inv.customerId !== cn.customerId) throw new EmrError('VALIDATION_FAILED', { message: 'A credit note applies only to the same customer\'s invoices.' });
    if (!OPEN.includes(inv.status)) throw new EmrError('INVALID_STATE', { message: `${inv.number} is not open.` });
    if (inv.currency !== 'NGN') throw new EmrError('INVALID_STATE', { message: 'Credit notes apply to naira invoices.' });
    if (amount > (await creditLeft(tx, context, rates, cn)) + 0.01 || amount > balanceOf(rates, inv) + 0.01) throw new EmrError('VALIDATION_FAILED', { message: 'That is more than is left on the credit note or the invoice.' });
    await tx.acctCreditApplication.create({ data: { ...org(context), creditNoteId: cn.id, invoiceId, kind: 'apply', amount, appliedByUserId: context.userId } });
    const paid = round2(Number(inv.amountPaid) + amount);
    await changeDoc(tx, context, inv, { amountPaid: paid, status: statusAfterPayment(rates, inv, paid) }, 'invoice.credit_applied');
    const left = await creditLeft(tx, context, rates, cn);
    await changeDoc(tx, context, cn, { status: left <= 0.01 ? 'Applied' : 'Partially Applied' }, 'credit_note.applied');
    return { id, left };
  });
}
export async function refundCreditNote(context, id, { amount, fromAccountNumber }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const cn = await docOf(tx, context, id, 'credit-note');
    if (!['Open', 'Partially Applied'].includes(cn.status)) throw new EmrError('INVALID_STATE', { message: 'This credit note has nothing left to refund.' });
    if (amount > (await creditLeft(tx, context, rates, cn)) + 0.01) throw new EmrError('VALIDATION_FAILED', { message: 'That is more than is left on the credit note.' });
    const cust = await customerOf(tx, context, cn.customerId);
    const entry = await postEntry(tx, context, {
      date: new Date(), source: 'Credit Note', memo: `Refund on credit note ${cn.number} — ${cust.name}`, reference: cn.number,
      lines: [{ accountNumber: cust.arAccountNumber, debit: amount, credit: 0, description: 'Reverse customer credit', customerId: cust.id }, { accountNumber: fromAccountNumber, debit: 0, credit: amount, description: `Refund to ${cust.name}` }],
    });
    await tx.acctCreditApplication.create({ data: { ...org(context), creditNoteId: cn.id, kind: 'refund', amount, cashAccountNumber: fromAccountNumber, journalEntryId: entry.id, appliedByUserId: context.userId } });
    const left = await creditLeft(tx, context, rates, cn);
    await changeDoc(tx, context, cn, { refundedAmount: round2(Number(cn.refundedAmount) + amount), status: left <= 0.01 ? 'Refunded' : cn.status }, 'credit_note.refunded');
    return { id };
  });
}

// ---- cash-sale and refund receipts ------------------------------------------------------------------
export async function createSalesReceipt(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const cust = input.customerId ? await customerOf(tx, context, input.customerId) : null;
    const lines = await cleanLines(tx, context, input.lines, rates);
    if (docTotal(rates, lines) <= 0) throw new EmrError('VALIDATION_FAILED', { message: 'Add at least one line with an amount.' });
    const who = cust?.name ?? input.customerName ?? 'Cash customer';
    const sr = await createDoc(tx, context, 'sales-receipt', { ...(input.id ? { id: input.id } : {}), customerId: cust?.id ?? null, customerName: cust ? null : input.customerName ?? null, docDate: new Date(input.date), lines, notes: input.notes ?? null, status: 'Completed', method: input.method, cashAccountNumber: input.depositAccountNumber });
    const jl = [
      ...lines.map((l) => ({ accountNumber: l.accountNumber, debit: 0, credit: lineAmount(l), description: l.description })),
      ...docTaxBreakdown(rates, lines).filter((b) => b.amount > 0).map((b) => ({ accountNumber: b.accountNumber, debit: 0, credit: b.amount, description: `Output ${b.label} — ${sr.number}` })),
    ];
    jl.unshift({ accountNumber: input.depositAccountNumber, debit: round2(jl.reduce((n, l) => n + l.credit, 0)), credit: 0, description: `${input.method} — ${who}` });
    const entry = await postEntry(tx, context, { date: sr.docDate, source: 'Sales Receipt', memo: `Sales receipt ${sr.number} — ${who}`, reference: sr.number, lines: jl });
    await tx.acctSalesDoc.updateMany({ where: { ...org(context), id: sr.id }, data: { journalEntryId: entry.id } });
    await audited(tx, context, 'sales_receipt.recorded', 'sales_receipt', sr.id);
    return { id: sr.id, number: sr.number };
  });
}
export async function createRefundReceipt(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const cust = await customerOf(tx, context, input.customerId);
    const lines = await cleanLines(tx, context, input.lines, rates);
    if (docTotal(rates, lines) <= 0) throw new EmrError('VALIDATION_FAILED', { message: 'Add at least one line with an amount.' });
    const rr = await createDoc(tx, context, 'refund-receipt', { ...(input.id ? { id: input.id } : {}), customerId: cust.id, docDate: new Date(input.date), lines, reason: input.reason, notes: input.notes ?? null, status: 'Completed', method: input.method, cashAccountNumber: input.fromAccountNumber });
    const jl = [
      ...lines.map((l) => ({ accountNumber: l.accountNumber, debit: lineAmount(l), credit: 0, description: l.description, customerId: cust.id })),
      ...docTaxBreakdown(rates, lines).filter((b) => b.amount > 0).map((b) => ({ accountNumber: b.accountNumber, debit: b.amount, credit: 0, description: `${b.label} reversed — ${rr.number}`, customerId: cust.id })),
    ];
    jl.push({ accountNumber: input.fromAccountNumber, debit: 0, credit: round2(jl.reduce((n, l) => n + l.debit, 0)), description: `Refund to ${cust.name}` });
    const entry = await postEntry(tx, context, { date: rr.docDate, source: 'Refund Receipt', memo: `Refund ${rr.number} — ${cust.name}`, reference: rr.number, lines: jl });
    await tx.acctSalesDoc.updateMany({ where: { ...org(context), id: rr.id }, data: { journalEntryId: entry.id } });
    await audited(tx, context, 'refund_receipt.issued', 'refund_receipt', rr.id);
    return { id: rr.id, number: rr.number };
  });
}

// ---- delayed charges --------------------------------------------------------------------------------
export async function addDelayedCharge(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await customerOf(tx, context, input.customerId);
    await cleanLines(tx, context, [{ accountNumber: input.accountNumber, description: input.description, qty: input.qty, unitPrice: input.unitPrice, ...(input.taxRateId ? { taxRateId: input.taxRateId } : {}) }], await taxRates(tx, context));
    const c = await tx.acctDelayedCharge.create({ data: { ...(input.id ? { id: input.id } : {}), ...org(context), customerId: input.customerId, chargeDate: new Date(input.date), accountNumber: input.accountNumber, description: input.description, qty: input.qty, unitPrice: input.unitPrice, taxRateId: input.taxRateId ?? null, createdByUserId: context.userId } });
    await audited(tx, context, 'delayed_charge.added', 'delayed_charge', c.id);
    return { id: c.id };
  });
}
export async function removeDelayedCharge(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const { count } = await tx.acctDelayedCharge.updateMany({ where: { ...org(context), id, status: 'Unbilled', removedAt: null }, data: { removedAt: new Date() } });
    if (!count) throw new EmrError('INVALID_STATE', { message: 'Only an unbilled charge can be removed.' });
    await audited(tx, context, 'delayed_charge.removed', 'delayed_charge', id);
    return { id };
  });
}

// ---- revenue recognition, recurring invoices, FX revaluation ----------------------------------------
export async function recognizeRevenue(context, scheduleId, { period }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const sch = await tx.acctRevenueSchedule.findFirst({ where: { ...org(context), id: scheduleId } });
    if (!sch) throw notFound('Revenue schedule');
    const inv = await docOf(tx, context, sch.invoiceId, 'invoice');
    if (inv.status === 'Draft' || inv.status === 'Void') throw new EmrError('INVALID_STATE', { message: 'Issue the invoice before recognising its revenue.' });
    const entry = sch.entries.find((e) => e.period === period && !e.recognized);
    if (!entry) throw new EmrError('INVALID_STATE', { message: 'Nothing to recognise for that period.' });
    const [py, pm] = period.split('-').map(Number);
    const periodEnd = new Date(Date.UTC(py, pm, 0, 12));
    if (periodEnd.getTime() > Date.now() && new Date(Date.UTC(py, pm - 1, 1)).getTime() > Date.now()) throw new EmrError('INVALID_STATE', { message: 'That period has not started yet.' });
    const je = await postEntry(tx, context, {
      date: new Date(Math.min(periodEnd.getTime(), Date.now())), source: 'Manual', memo: `Revenue recognised — ${period} (${inv.number})`, reference: inv.number,
      lines: [{ accountNumber: sch.deferredAccountNumber, debit: entry.amount, credit: 0, description: 'Release deferred revenue', customerId: sch.customerId }, { accountNumber: sch.revenueAccountNumber, debit: 0, credit: entry.amount, description: `Recognised revenue — ${period}`, customerId: sch.customerId }],
    });
    await updateVersioned(tx.acctRevenueSchedule, { organizationId: context.organizationId, id: sch.id, expectedVersion: sch.version, data: { entries: sch.entries.map((e) => (e.id === entry.id ? { ...e, recognized: true, recognizedAt: new Date().toISOString(), journalEntryId: je.id } : e)) }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'revenue.recognised', 'revenue_schedule', sch.id, [period]);
    return { id: sch.id };
  });
}
export async function runRecurringInvoices(context, { asOf }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const when = new Date(asOf);
    const due = await tx.acctSalesDoc.findMany({ where: { ...org(context), kind: 'invoice', recurEveryMonths: { not: null }, recurNextDate: { lte: when }, status: { not: 'Void' } } });
    const created = [];
    for (const src of due) {
      let next = src.recurNextDate;
      while (next <= when && (!src.recurEndDate || next <= src.recurEndDate)) {
        const inv = await createInvoiceInTx(tx, context, { customerId: src.customerId, date: next, lines: src.lines, notes: `Recurring from ${src.number}`, currency: src.currency, exchangeRate: Number(src.exchangeRate), projectId: src.projectId ?? undefined });
        await issueInvoiceInTx(tx, context, inv.id, { overrideCredit: can(context, 'acct.approve') });
        created.push(inv.id);
        next = monthsAdd(next, src.recurEveryMonths);
      }
      await tx.acctSalesDoc.updateMany({ where: { ...org(context), id: src.id }, data: { recurNextDate: next, version: { increment: 1 } } });
    }
    if (created.length) await audited(tx, context, 'invoice.recurring_run', 'invoice', null, [String(created.length)]);
    return { created };
  });
}
export async function revalueForeign(context, { asOf, rates: newRates }) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const open = await tx.acctSalesDoc.findMany({ where: { ...org(context), kind: 'invoice', currency: { not: 'NGN' }, status: { in: OPEN } } });
    let adjusted = 0; let net = 0;
    for (const inv of open) {
      const to = newRates[inv.currency];
      const from = Number(inv.exchangeRate);
      if (!to || Math.abs(to - from) < 0.005) continue;
      const delta = round2(balanceOf(rates, inv) * (to - from));
      if (Math.abs(delta) < 0.005) continue;
      const cust = await customerOf(tx, context, inv.customerId);
      await postEntry(tx, context, {
        date: new Date(asOf), source: 'FX Revaluation', memo: `FX revaluation — ${inv.number} (${inv.currency} ${from} → ${to})`, reference: inv.number,
        lines: delta > 0
          ? [{ accountNumber: cust.arAccountNumber, debit: delta, credit: 0, customerId: cust.id }, { accountNumber: ACCT.fxGain, debit: 0, credit: delta, description: 'Unrealised FX gain' }]
          : [{ accountNumber: ACCT.fxLoss, debit: -delta, credit: 0, description: 'Unrealised FX loss' }, { accountNumber: cust.arAccountNumber, debit: 0, credit: -delta, customerId: cust.id }],
      });
      await changeDoc(tx, context, inv, { exchangeRate: to }, 'invoice.revalued');
      adjusted += 1; net = round2(net + delta);
    }
    return { module: 'AR', adjusted, net };
  });
}

// ---- reminders and statements -----------------------------------------------------------------------
async function reminderDue(tx, context, settings, inv) {
  if (!OPEN.includes(inv.status) || !inv.dueDate) return null;
  const overdueDays = Math.floor((Date.now() - inv.dueDate.getTime()) / 86_400_000);
  if (overdueDays <= 0) return null;
  const sent = (await tx.acctCustomerNotice.aggregate({ where: { ...org(context), kind: 'reminder', invoiceId: inv.id }, _max: { level: true } }))._max.level ?? 0;
  return settings.reminderRules.filter((r) => r.active && r.daysOverdue <= overdueDays && r.level > sent).sort((a, b) => b.level - a.level)[0] ?? null;
}
const money = (amount, currency = 'NGN') => `${currency === 'NGN' ? '₦' : `${currency} `}${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? d.toISOString().slice(0, 10) : '');
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (all, key) => (values[key] === undefined ? all : String(values[key])));
const hospitalNameOf = (settings, sender) => settings.orgProfile?.tradingName || settings.orgProfile?.legalName || sender.hospitalName;

async function sendReminderInTx(tx, context, settings, inv, sender) {
  const rule = await reminderDue(tx, context, settings, inv);
  if (!rule) return null;
  const cust = await customerOf(tx, context, inv.customerId);
  const notice = await tx.acctCustomerNotice.create({ data: { ...org(context), kind: 'reminder', customerId: cust.id, invoiceId: inv.id, level: rule.level, tone: rule.tone, sentTo: cust.email ?? null, sentByUserId: context.userId } });
  const rates = await taxRates(tx, context);
  const values = { number: inv.number, amount: money(balanceOf(rates, inv), inv.currency), dueDate: day(inv.dueDate), daysOverdue: Math.floor((Date.now() - inv.dueDate.getTime()) / 86_400_000), customer: cust.name };
  const delivery = await queueCustomerEmail(tx, context, {
    noticeId: notice.id, recipient: cust.email, sender, hospitalName: hospitalNameOf(settings, sender),
    subject: fill(rule.subject || `Reminder — invoice {number}`, values), body: `Dear ${cust.name},\n\n${fill(rule.body || 'Invoice {number} for {amount} was due on {dueDate}.', values)}\n\nA copy of the invoice is attached.`,
    attachment: cust.email ? await invoicePdfInTx(tx, context, inv, sender) : undefined,
  });
  await audited(tx, context, 'invoice.reminder_recorded', 'invoice', inv.id, [String(rule.level), delivery.status]);
  return { level: rule.level, delivery };
}
export async function sendReminder(context, invoiceId) {
  requireAcct(context, 'acct.post');
  const sender = await senderFor(context);
  return withTenant(context, async (tx) => {
    const settings = await ensureSettings(tx, context);
    const sent = await sendReminderInTx(tx, context, settings, await docOf(tx, context, invoiceId, 'invoice'), sender);
    if (!sent) throw new EmrError('INVALID_STATE', { message: 'No reminder is due on this invoice.' });
    return { ok: true, ...sent };
  });
}
export async function runReminders(context) {
  requireAcct(context, 'acct.post');
  const sender = await senderFor(context);
  return withTenant(context, async (tx) => {
    const settings = await ensureSettings(tx, context);
    let sent = 0; let emailed = 0;
    for (const inv of await tx.acctSalesDoc.findMany({ where: { ...org(context), kind: 'invoice', status: { in: OPEN }, dueDate: { lt: new Date() } } })) {
      const r = await sendReminderInTx(tx, context, settings, inv, sender);
      if (r) { sent += 1; if (r.delivery.status === 'QUEUED') emailed += 1; }
    }
    return { sent, emailed, notEmailed: sent - emailed };
  });
}
/** Records a statement of account for the customer and emails it, with the statement attached as a PDF. */
export async function markStatementSent(context, customerId, period = {}) {
  requireAcct(context, 'acct.post');
  const sender = await senderFor(context);
  return withTenant(context, async (tx) => {
    const cust = await customerOf(tx, context, customerId);
    if (!cust.email) throw new EmrError('VALIDATION_FAILED', { message: `${cust.name} has no email address on file.` });
    const settings = await ensureSettings(tx, context);
    const built = await customerStatementInTx(tx, context, customerId, period);
    const { statement: st } = built;
    const lines = st.open.map((i) => `  ${i.number}  ·  due ${day(i.dueDate)}  ·  ${money(i.balance, i.currency)}${i.overdue ? '  (overdue)' : ''}`);
    const hospitalName = hospitalNameOf(settings, sender);
    const notice = await tx.acctCustomerNotice.create({ data: { ...org(context), kind: 'statement', customerId, sentTo: cust.email, sentByUserId: context.userId } });
    const delivery = await queueCustomerEmail(tx, context, {
      noticeId: notice.id, recipient: cust.email, sender, hospitalName, attachment: await statementPdf(settings, sender, built),
      subject: `Statement of account — ${hospitalName}`,
      body: [
        `Dear ${cust.name},`, '',
        `Your statement of account with ${hospitalName} from ${day(st.from)} to ${day(st.to)} is attached.`, '',
        `Opening balance: ${money(st.openingBalance)}`, `Closing balance: ${money(st.closingBalance)}`,
        ...(lines.length ? ['', 'Open invoices:', ...lines] : []),
        ...(settings.orgProfile?.paymentInstructions ? ['', 'How to pay:', settings.orgProfile.paymentInstructions] : []),
      ].join('\n'),
    });
    await audited(tx, context, 'customer.statement_recorded', 'customer', customerId, [delivery.status]);
    return { ok: true, to: cust.email, closingBalance: st.closingBalance, delivery };
  });
}
/** Emails an issued invoice to its customer (or another address given), with the invoice attached. */
export async function emailInvoice(context, invoiceId, { to } = {}) {
  requireAcct(context, 'acct.post');
  const sender = await senderFor(context);
  return withTenant(context, async (tx) => {
    const inv = await docOf(tx, context, invoiceId, 'invoice');
    if (inv.status === 'Draft' || inv.status === 'Void') throw new EmrError('INVALID_STATE', { message: `Issue the invoice before emailing it${inv.status === 'Void' ? ' (this one is void)' : ''}.` });
    const cust = await customerOf(tx, context, inv.customerId);
    const recipient = to ?? cust.email;
    if (!recipient) throw new EmrError('VALIDATION_FAILED', { message: `${cust.name} has no email address on file.` });
    const settings = await ensureSettings(tx, context);
    const rates = await taxRates(tx, context);
    const hospitalName = hospitalNameOf(settings, sender);
    const notice = await tx.acctCustomerNotice.create({ data: { ...org(context), kind: 'invoice', customerId: cust.id, invoiceId: inv.id, sentTo: recipient, sentByUserId: context.userId } });
    const delivery = await queueCustomerEmail(tx, context, {
      noticeId: notice.id, recipient, sender, hospitalName, attachment: await invoicePdfInTx(tx, context, inv, sender),
      subject: `Invoice ${inv.number} from ${hospitalName}`,
      body: [
        `Dear ${cust.name},`, '',
        `Please find attached invoice ${inv.number} dated ${day(inv.docDate)} for ${money(total(rates, inv), inv.currency)}.`,
        `Amount due: ${money(balanceOf(rates, inv), inv.currency)}${inv.dueDate ? `, by ${day(inv.dueDate)}` : ''}.`,
        ...(settings.orgProfile?.paymentInstructions ? ['', 'How to pay:', settings.orgProfile.paymentInstructions] : []),
      ].join('\n'),
    });
    await audited(tx, context, 'invoice.emailed', 'invoice', inv.id, [delivery.status]);
    return { ok: true, to: recipient, delivery };
  });
}
