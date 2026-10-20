// Payables: vendors, purchase requisitions, purchase orders, goods receipts, bills, vendor payments and
// vendor credits.
//
// Rules enforced here:
//   - a requisition or bill that an approval rule covers waits for its approval (built from the rules, never
//     decided by its submitter); a bill posts only once approved — Dr each line's account and the recoverable
//     input tax, Cr the vendor's payable — and voiding reverses it (only if nothing has been paid);
//   - goods are received against a sent order, never beyond what was ordered;
//   - a payment settles the vendor's own posted bills, never more than their balance; withholding tax goes
//     to WHT Payable; foreign settlements book the realised FX gain or loss;
//   - a vendor credit applies to the same vendor's bills, within what is left of both;
//   - acct.view reads, acct.post prepares, submits, posts and pays; FX revaluation is the controller's.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { postEntry, requireAcct, reverseInTx, round2 } from '../ledger/ledger.service.js';
import { docTaxBreakdown, docTotal, dueDateFor, ensureSettings, lineAmount, nextDocNumber, taxRates } from '../settings/settings.service.js';
import { NOT_REQUIRED, approvalUserIds, buildApproval, decideApproval, presentApproval } from '../control/approvals.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const notFound = (what) => new EmrError('HR_RECORD_NOT_FOUND', { message: `${what} not found.` });
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
const ACCT = { apTrade: 2000, wht: 2210, fxGain: 4110, fxLoss: 5610, openingEquity: 3900 };
const OPEN_BILL = ['Awaiting Payment', 'Partially Paid'];
const NAMES = { requisition: 'Requisition', po: 'Purchase order', bill: 'Bill', 'vendor-credit': 'Vendor credit' };
const monthsAdd = (d, m) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, d.getUTCDate(), 12));
const rid = () => Math.random().toString(36).slice(2, 10);

async function vendorOf(tx, context, id) {
  const v = await tx.acctVendor.findFirst({ where: { ...org(context), id } });
  if (!v) throw notFound('Vendor');
  return v;
}
async function docOf(tx, context, id, kind) {
  const d = await tx.acctPurchaseDoc.findFirst({ where: { ...org(context), id, kind } });
  if (!d) throw notFound(NAMES[kind]);
  return d;
}
async function cleanLines(tx, context, lines, rates) {
  if (!lines.length) throw new EmrError('VALIDATION_FAILED', { message: 'Add at least one line.' });
  const accounts = new Map((await tx.acctAccount.findMany({ where: { ...org(context), number: { in: [...new Set(lines.map((l) => l.accountNumber))] } } })).map((a) => [a.number, a]));
  return lines.map((l) => {
    const a = accounts.get(l.accountNumber);
    if (!a || !a.isActive) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${l.accountNumber} is not available.` });
    for (const id of [...(l.taxRateIds ?? []), ...(l.taxRateId ? [l.taxRateId] : [])]) if (!rates.has(id)) throw new EmrError('VALIDATION_FAILED', { message: `Unknown tax rate ${id}.` });
    return { id: l.id ?? `pl-${rid()}`, accountNumber: l.accountNumber, description: l.description, qty: l.qty, unitPrice: l.unitPrice, ...(l.taxRateId ? { taxRateId: l.taxRateId } : {}), ...(l.taxRateIds?.length ? { taxRateIds: l.taxRateIds } : {}), ...(l.itemId ? { itemId: l.itemId } : {}) };
  });
}
const total = (rates, d) => docTotal(rates, d.lines);
const billBalance = (rates, b) => round2(total(rates, b) - Number(b.amountPaid));
const paidStatus = (rates, b, paid) => (paid >= total(rates, b) - 0.01 ? 'Paid' : paid > 0.01 ? 'Partially Paid' : 'Awaiting Payment');
const shownStatus = (status, due) => (OPEN_BILL.includes(status) && due && due < new Date() ? 'Overdue' : status);
async function createDoc(tx, context, kind, seqKey, fields) {
  const number = await nextDocNumber(tx, context, seqKey);
  try { return await tx.acctPurchaseDoc.create({ data: { ...org(context), kind, number, createdByUserId: context.userId, ...fields } }); } catch (error) { throw uniqueViolation(error, { pkey: 'HR_CODE_IN_USE', number_key: 'HR_CODE_IN_USE' }) ?? error; }
}
async function changeDoc(tx, context, d, data, action) {
  await updateVersioned(tx.acctPurchaseDoc, { organizationId: context.organizationId, id: d.id, expectedVersion: d.version, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
  await audited(tx, context, action, d.kind.replace('-', '_'), d.id, Object.keys(data));
}

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    await ensureSettings(tx, context);
    const [vendors, docs, receipts, payments, credits] = await Promise.all([
      tx.acctVendor.findMany({ where: org(context), orderBy: { name: 'asc' } }),
      tx.acctPurchaseDoc.findMany({ where: org(context), orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }] }),
      tx.acctGoodsReceipt.findMany({ where: org(context), orderBy: { receiptDate: 'desc' } }),
      tx.acctVendorPayment.findMany({ where: org(context), orderBy: { paymentDate: 'desc' } }),
      tx.acctVendorCreditApplication.findMany({ where: org(context), orderBy: { appliedAt: 'asc' } }),
    ]);
    const names = await userNameMap(tx, [...docs.flatMap((d) => [d.createdByUserId, ...approvalUserIds(d.approval)]), ...receipts.map((g) => g.receivedByUserId), ...payments.map((p) => p.createdByUserId)]);
    const who = (id) => names.get(id) ?? 'Former member';
    const iso = (d) => (d ? d.toISOString() : undefined);
    const of = (kind) => docs.filter((d) => d.kind === kind);
    return {
      vendors: vendors.map((v) => ({
        id: v.id, name: v.name, email: v.email ?? undefined, phone: v.phone ?? undefined, address: v.address ?? undefined, taxId: v.taxId ?? undefined, category: v.category, currency: v.currency,
        paymentTermsDays: v.paymentTermsDays, paymentTermId: v.paymentTermId ?? undefined, apAccountNumber: v.apAccountNumber, openingBalance: 0, active: v.active, createdAt: v.createdAt, version: v.version,
      })),
      requisitions: of('requisition').map((d) => ({
        id: d.id, number: d.number, vendorId: d.vendorId ?? undefined, requestedBy: who(d.createdByUserId), department: d.department ?? undefined, date: iso(d.docDate), needBy: iso(d.needBy), lines: d.lines,
        justification: d.justification ?? '', status: d.status, approval: presentApproval(context, d.approval, names), purchaseOrderId: d.convertedToId ?? undefined, createdAt: d.createdAt, version: d.version,
      })),
      purchaseOrders: of('po').map((d) => ({
        id: d.id, number: d.number, vendorId: d.vendorId, requisitionId: d.sourceDocId ?? undefined, date: iso(d.docDate), expectedDate: iso(d.expectedDate), lines: d.lines, notes: d.notes ?? undefined,
        status: d.status, billId: d.convertedToId ?? undefined, createdBy: who(d.createdByUserId), createdAt: d.createdAt, version: d.version,
      })),
      goodsReceipts: receipts.map((g) => ({ id: g.id, number: g.number, purchaseOrderId: g.purchaseOrderId, vendorId: g.vendorId, date: iso(g.receiptDate), receivedBy: who(g.receivedByUserId), lines: g.lines, notes: g.notes ?? undefined, createdAt: g.createdAt, stockedLineIds: g.stockedLineIds })),
      bills: of('bill').map((d) => ({
        id: d.id, number: d.number, vendorInvoiceNumber: d.vendorInvoiceNumber ?? undefined, vendorId: d.vendorId, purchaseOrderId: d.sourceDocId ?? undefined, projectId: d.projectId ?? undefined,
        date: iso(d.docDate), dueDate: iso(d.dueDate), lines: d.lines, notes: d.notes ?? undefined, status: shownStatus(d.status, d.dueDate), approval: presentApproval(context, d.approval, names),
        amountPaid: Number(d.amountPaid), currency: d.currency, exchangeRate: Number(d.exchangeRate), journalEntryId: d.journalEntryId ?? undefined, createdBy: who(d.createdByUserId), createdAt: d.createdAt,
        postedAt: iso(d.postedAt), version: d.version, ...(d.recurEveryMonths ? { isRecurring: true, recurrenceEveryMonths: d.recurEveryMonths, recurrenceNextDate: iso(d.recurNextDate), recurrenceEndDate: iso(d.recurEndDate) } : {}),
      })),
      vendorPayments: payments.map((p) => ({
        id: p.id, number: p.number, vendorId: p.vendorId, date: iso(p.paymentDate), method: p.method, fromAccountNumber: p.fromAccountNumber, amount: Number(p.amount), allocations: p.allocations,
        settlementRate: p.settlementRate === null ? undefined : Number(p.settlementRate), reference: p.reference ?? undefined, withheldTax: Number(p.withheldTax) || undefined, journalEntryId: p.journalEntryId,
        approval: { ...NOT_REQUIRED }, createdBy: who(p.createdByUserId), createdAt: p.createdAt,
      })),
      vendorCredits: of('vendor-credit').map((d) => ({
        id: d.id, number: d.number, vendorId: d.vendorId, billId: d.sourceDocId ?? undefined, date: iso(d.docDate), lines: d.lines, reason: d.reason ?? '', status: d.status,
        applications: credits.filter((a) => a.vendorCreditId === d.id).map((a) => ({ billId: a.billId, amount: Number(a.amount), date: iso(a.appliedAt) })), journalEntryId: d.journalEntryId ?? undefined,
        createdBy: who(d.createdByUserId), createdAt: d.createdAt, version: d.version,
      })),
    };
  });
}

// ---- vendors ----------------------------------------------------------------------------------------
export async function addVendor(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const settings = await ensureSettings(tx, context);
    if (input.paymentTermId && !settings.paymentTerms.some((t) => t.id === input.paymentTermId)) throw new EmrError('VALIDATION_FAILED', { message: 'Unknown payment term.' });
    const v = await tx.acctVendor.create({
      data: { ...(input.id ? { id: input.id } : {}), ...org(context), name: input.name, email: input.email ?? null, phone: input.phone ?? null, address: input.address ?? null, taxId: input.taxId ?? null, category: input.category, currency: input.currency ?? 'NGN', paymentTermsDays: input.paymentTermsDays ?? 30, paymentTermId: input.paymentTermId ?? null, apAccountNumber: ACCT.apTrade },
    });
    if ((input.openingBalance ?? 0) > 0) {
      const ledger = await tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } });
      await postEntry(tx, context, {
        date: ledger.booksLockedBefore ?? new Date(), source: 'Opening Balance', memo: `Opening AP balance — ${v.name}`, skipLock: true,
        lines: [{ accountNumber: ACCT.openingEquity, debit: input.openingBalance, credit: 0 }, { accountNumber: v.apAccountNumber, debit: 0, credit: input.openingBalance, vendorId: v.id }],
      });
    }
    await audited(tx, context, 'vendor.created', 'vendor', v.id);
    return { id: v.id };
  });
}
export async function updateVendor(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await vendorOf(tx, context, id);
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.acctVendor, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'vendor.updated', 'vendor', id, Object.keys(data));
    return { id };
  });
}

// ---- requisitions -----------------------------------------------------------------------------------
export async function createRequisition(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    if (input.vendorId) await vendorOf(tx, context, input.vendorId);
    const lines = await cleanLines(tx, context, input.lines, await taxRates(tx, context));
    const d = await createDoc(tx, context, 'requisition', 'requisition', {
      ...(input.id ? { id: input.id } : {}), vendorId: input.vendorId ?? null, department: input.department ?? null, docDate: new Date(input.date), needBy: input.needBy ? new Date(input.needBy) : null,
      lines, justification: input.justification, status: 'Draft', approval: NOT_REQUIRED,
    });
    return { id: d.id, number: d.number };
  });
}
export async function submitRequisition(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const d = await docOf(tx, context, id, 'requisition');
    if (!['Draft', 'Rejected'].includes(d.status)) throw new EmrError('INVALID_STATE', { message: 'This requisition has already been submitted.' });
    const approval = await buildApproval(tx, context, 'Purchase Requisition', total(await taxRates(tx, context), d));
    await changeDoc(tx, context, d, { approval, status: approval.status === 'Not Required' ? 'Approved' : 'Pending Approval' }, 'requisition.submitted');
    return { id, status: approval.status === 'Not Required' ? 'Approved' : 'Pending Approval' };
  });
}
export async function decideRequisition(context, id, { decision, comment }) {
  return withTenant(context, async (tx) => {
    const d = await docOf(tx, context, id, 'requisition');
    const approval = decideApproval(context, d.approval, decision, comment);
    const status = approval.status === 'Approved' ? 'Approved' : approval.status === 'Rejected' ? 'Rejected' : d.status;
    await changeDoc(tx, context, d, { approval, status }, `requisition.${decision.toLowerCase()}`);
    return { id, status };
  });
}

// ---- purchase orders and goods receipts -------------------------------------------------------------
async function createPOInTx(tx, context, input) {
  await vendorOf(tx, context, input.vendorId);
  const lines = await cleanLines(tx, context, input.lines, await taxRates(tx, context));
  return createDoc(tx, context, 'po', 'po', { ...(input.id ? { id: input.id } : {}), vendorId: input.vendorId, sourceDocId: input.requisitionId ?? null, docDate: new Date(input.date), expectedDate: input.expectedDate ? new Date(input.expectedDate) : null, lines, notes: input.notes ?? null, status: 'Draft' });
}
export async function createPurchaseOrder(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => { const d = await createPOInTx(tx, context, input); return { id: d.id, number: d.number }; });
}
export async function convertRequisition(context, id, { vendorId, newId }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const pr = await docOf(tx, context, id, 'requisition');
    if (pr.status !== 'Approved') throw new EmrError('INVALID_STATE', { message: 'Only an approved requisition becomes an order.' });
    const po = await createPOInTx(tx, context, { id: newId, vendorId, date: new Date(), lines: pr.lines, requisitionId: pr.id });
    await changeDoc(tx, context, pr, { status: 'Ordered', convertedToId: po.id }, 'requisition.ordered');
    return { id: po.id };
  });
}
export async function setOrderStatus(context, id, { status }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const d = await docOf(tx, context, id, 'po');
    const ok = status === 'Sent' ? d.status === 'Draft' : ['Draft', 'Sent'].includes(d.status);
    if (!ok) throw new EmrError('INVALID_STATE', { message: `A ${d.status.toLowerCase()} order cannot be ${status.toLowerCase()}.` });
    await changeDoc(tx, context, d, { status }, `po.${status.toLowerCase()}`);
    return { id, status };
  });
}
export async function receiveGoods(context, poId, { received, notes, id }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const po = await docOf(tx, context, poId, 'po');
    if (!['Sent', 'Partially Received'].includes(po.status)) throw new EmrError('INVALID_STATE', { message: 'Goods are received against a sent order.' });
    const before = await tx.acctGoodsReceipt.findMany({ where: { ...org(context), purchaseOrderId: poId } });
    const got = (lineId) => before.reduce((n, g) => n + (g.lines.find((l) => l.poLineId === lineId)?.qtyReceived ?? 0), 0);
    const lines = po.lines.map((l) => {
      const qty = received.find((r) => r.poLineId === l.id)?.qtyReceived ?? 0;
      if (qty < 0 || got(l.id) + qty > l.qty) throw new EmrError('VALIDATION_FAILED', { message: `More than was ordered of "${l.description}".` });
      return { poLineId: l.id, description: l.description, qtyOrdered: l.qty, qtyReceived: qty, ...(l.itemId ? { itemId: l.itemId } : {}) };
    });
    if (!lines.some((l) => l.qtyReceived > 0)) throw new EmrError('VALIDATION_FAILED', { message: 'Record what was received.' });
    const number = await nextDocNumber(tx, context, 'goods-receipt');
    const g = await tx.acctGoodsReceipt.create({ data: { ...(id ? { id } : {}), ...org(context), number, purchaseOrderId: poId, vendorId: po.vendorId, receiptDate: new Date(), receivedByUserId: context.userId, lines, notes: notes ?? null } });
    const full = lines.every((l) => got(l.poLineId) + l.qtyReceived >= l.qtyOrdered);
    await changeDoc(tx, context, po, { status: full ? 'Received' : 'Partially Received' }, 'po.goods_received');
    return { id: g.id, number };
  });
}
export async function markReceiptStocked(context, id, { poLineIds }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const g = await tx.acctGoodsReceipt.findFirst({ where: { ...org(context), id } });
    if (!g) throw notFound('Goods receipt');
    await tx.acctGoodsReceipt.updateMany({ where: { ...org(context), id }, data: { stockedLineIds: [...new Set([...g.stockedLineIds, ...poLineIds])] } });
    return { id };
  });
}

// ---- bills ------------------------------------------------------------------------------------------
async function createBillInTx(tx, context, input) {
  const settings = await ensureSettings(tx, context);
  const vendor = await vendorOf(tx, context, input.vendorId);
  const lines = await cleanLines(tx, context, input.lines, await taxRates(tx, context));
  const currency = input.currency ?? vendor.currency ?? 'NGN';
  const ledger = await tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } });
  const rate = currency === 'NGN' ? 1 : input.exchangeRate ?? ledger.fxRates.find((r) => r.code === currency)?.rateToNgn;
  if (!rate) throw new EmrError('VALIDATION_FAILED', { message: `No exchange rate is set for ${currency}.` });
  const date = new Date(input.date);
  return createDoc(tx, context, 'bill', 'bill', {
    ...(input.id ? { id: input.id } : {}), vendorId: vendor.id, vendorInvoiceNumber: input.vendorInvoiceNumber ?? null, sourceDocId: input.purchaseOrderId ?? null, projectId: input.projectId ?? null,
    docDate: date, dueDate: input.dueDate ? new Date(input.dueDate) : dueDateFor(settings, date, vendor.paymentTermId, vendor.paymentTermsDays), lines, notes: input.notes ?? null, status: 'Draft', approval: NOT_REQUIRED,
    currency, exchangeRate: rate, ...(input.recurEveryMonths ? { recurEveryMonths: input.recurEveryMonths, recurNextDate: monthsAdd(date, input.recurEveryMonths), recurEndDate: input.recurEndDate ? new Date(input.recurEndDate) : null } : {}),
  });
}
export async function createBill(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => { const d = await createBillInTx(tx, context, input); return { id: d.id, number: d.number }; });
}
export async function convertPO(context, id, { newId }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const po = await docOf(tx, context, id, 'po');
    if (!['Sent', 'Partially Received', 'Received'].includes(po.status)) throw new EmrError('INVALID_STATE', { message: 'Bill an order once it has been sent.' });
    const bill = await createBillInTx(tx, context, { id: newId, vendorId: po.vendorId, date: new Date(), lines: po.lines, purchaseOrderId: po.id });
    await changeDoc(tx, context, po, { status: 'Billed', convertedToId: bill.id }, 'po.billed');
    return { id: bill.id };
  });
}
export async function updateDraftDoc(context, kind, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const d = await docOf(tx, context, id, kind);
    if (d.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft can be edited.' });
    if (d.version !== expectedVersion) throw new EmrError('VERSION_CONFLICT');
    const data = Object.fromEntries(Object.entries({
      docDate: patch.date ? new Date(patch.date) : undefined, dueDate: patch.dueDate ? new Date(patch.dueDate) : undefined, vendorInvoiceNumber: patch.vendorInvoiceNumber, notes: patch.notes,
      lines: patch.lines ? await cleanLines(tx, context, patch.lines, await taxRates(tx, context)) : undefined,
    }).filter(([, v]) => v !== undefined));
    await changeDoc(tx, context, d, data, `${kind.replace('-', '_')}.updated`);
    return { id };
  });
}
async function postBillInTx(tx, context, bill) {
  const rates = await taxRates(tx, context);
  const vendor = await vendorOf(tx, context, bill.vendorId);
  if (total(rates, bill) <= 0) throw new EmrError('VALIDATION_FAILED', { message: 'Add at least one line with an amount.' });
  const rate = Number(bill.exchangeRate);
  const suffix = bill.currency !== 'NGN' ? ` (${bill.currency} ${total(rates, bill).toLocaleString('en-NG')} @ ${rate})` : '';
  const lines = bill.lines.map((l) => ({ accountNumber: l.accountNumber, debit: round2(lineAmount(l) * rate), credit: 0, description: l.description, vendorId: vendor.id, projectId: bill.projectId ?? undefined }));
  for (const b of docTaxBreakdown(rates, bill.lines)) if (b.amount > 0) lines.push({ accountNumber: b.accountNumber, debit: round2(b.amount * rate), credit: 0, description: `Recoverable input ${b.label} — ${bill.number}`, vendorId: vendor.id });
  lines.push({ accountNumber: vendor.apAccountNumber, debit: 0, credit: round2(lines.reduce((n, l) => n + l.debit, 0)), description: `${bill.number} — ${vendor.name}${suffix}`, vendorId: vendor.id });
  const entry = await postEntry(tx, context, { date: bill.docDate, source: 'Bill', memo: `Bill ${bill.number} — ${vendor.name}`, reference: bill.number, lines });
  return entry;
}
/** Submits a bill: posts it now if no rule covers its amount, otherwise it waits for approval. */
export async function submitBill(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const bill = await docOf(tx, context, id, 'bill');
    if (bill.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft bill can be submitted.' });
    const rates = await taxRates(tx, context);
    const approval = await buildApproval(tx, context, 'Bill', round2(total(rates, bill) * Number(bill.exchangeRate)));
    if (approval.status === 'Not Required') {
      const entry = await postBillInTx(tx, context, bill);
      await changeDoc(tx, context, bill, { status: 'Awaiting Payment', journalEntryId: entry.id, postedAt: new Date() }, 'bill.posted');
      return { id, status: 'Awaiting Payment' };
    }
    await changeDoc(tx, context, bill, { approval, status: 'Pending Approval' }, 'bill.submitted');
    return { id, status: 'Pending Approval' };
  });
}
export async function decideBill(context, id, { decision, comment }) {
  return withTenant(context, async (tx) => {
    const bill = await docOf(tx, context, id, 'bill');
    if (bill.status !== 'Pending Approval') throw new EmrError('INVALID_STATE', { message: 'This bill is not waiting for approval.' });
    const approval = decideApproval(context, bill.approval, decision, comment);
    if (approval.status === 'Approved') {
      const entry = await postBillInTx(tx, context, bill);
      await changeDoc(tx, context, bill, { approval, status: 'Awaiting Payment', journalEntryId: entry.id, postedAt: new Date() }, 'bill.approved');
      return { id, status: 'Awaiting Payment' };
    }
    await changeDoc(tx, context, bill, { approval, ...(approval.status === 'Rejected' ? { status: 'Void' } : {}) }, `bill.${decision.toLowerCase()}`);
    return { id, status: approval.status === 'Rejected' ? 'Void' : 'Pending Approval' };
  });
}
export async function voidBill(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const bill = await docOf(tx, context, id, 'bill');
    if (bill.status === 'Void') throw new EmrError('INVALID_STATE', { message: 'Already void.' });
    if (Number(bill.amountPaid) > 0) throw new EmrError('INVALID_STATE', { message: 'Un-apply payments before voiding.' });
    if (bill.journalEntryId) await reverseInTx(tx, context, bill.journalEntryId, { memo: `Void bill ${bill.number}` });
    await changeDoc(tx, context, bill, { status: 'Void' }, 'bill.voided');
    return { id, status: 'Void' };
  });
}

// ---- payments ---------------------------------------------------------------------------------------
export async function payVendor(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const vendor = await vendorOf(tx, context, input.vendorId);
    const from = await tx.acctAccount.findFirst({ where: { ...org(context), number: input.fromAccountNumber } });
    if (!from || !['cash', 'bank'].includes(from.subtype)) throw new EmrError('VALIDATION_FAILED', { message: 'Pay from a cash or bank account.' });
    const withheld = round2(input.withheldTax ?? 0);
    const allocations = input.allocations.filter((a) => a.amount > 0);
    let apRelief = 0; let fxDiff = 0; let bankFromAlloc = 0;
    const touched = [];
    for (const a of allocations) {
      const bill = await docOf(tx, context, a.billId, 'bill');
      if (bill.vendorId !== vendor.id) throw new EmrError('VALIDATION_FAILED', { message: `${bill.number} belongs to another vendor.` });
      if (!OPEN_BILL.includes(bill.status)) throw new EmrError('INVALID_STATE', { message: `${bill.number} is not open for payment.` });
      if (a.amount > billBalance(rates, bill) + 0.01) throw new EmrError('VALIDATION_FAILED', { message: `That is more than the ${billBalance(rates, bill).toLocaleString('en-NG')} left on ${bill.number}.` });
      const bookRate = Number(bill.exchangeRate);
      const setRate = bill.currency !== 'NGN' ? input.settlementRate ?? bookRate : 1;
      apRelief += a.amount * bookRate;
      fxDiff += a.amount * (bookRate - setRate); // paying less naira than booked is a gain
      bankFromAlloc += a.amount * setRate;
      touched.push({ bill, paid: round2(Number(bill.amountPaid) + a.amount) });
    }
    // The tax withheld is part of what settles the bills; the bank pays the rest.
    const unallocated = round2(input.amount + withheld - bankFromAlloc);
    if (unallocated < -0.01) throw new EmrError('VALIDATION_FAILED', { message: 'Allocations exceed the payment.' });
    fxDiff = round2(fxDiff);
    const lines = [
      { accountNumber: vendor.apAccountNumber, debit: round2(apRelief + Math.max(unallocated, 0)), credit: 0, description: `Settle ${allocations.length} bill(s) — ${vendor.name}`, vendorId: vendor.id },
      { accountNumber: input.fromAccountNumber, debit: 0, credit: input.amount, description: `${input.method} to ${vendor.name}` },
    ];
    if (withheld > 0) lines.push({ accountNumber: ACCT.wht, debit: 0, credit: withheld, description: `WHT withheld — ${vendor.name}` });
    if (fxDiff > 0.005) lines.push({ accountNumber: ACCT.fxGain, debit: 0, credit: fxDiff, description: 'Realised FX gain on settlement' });
    else if (fxDiff < -0.005) lines.push({ accountNumber: ACCT.fxLoss, debit: -fxDiff, credit: 0, description: 'Realised FX loss on settlement' });
    const number = await nextDocNumber(tx, context, 'payment');
    const entry = await postEntry(tx, context, { date: new Date(input.date), source: 'Vendor Payment', memo: `Payment ${number} — ${vendor.name}`, reference: number, lines });
    const p = await tx.acctVendorPayment.create({
      data: { ...(input.id ? { id: input.id } : {}), ...org(context), number, vendorId: vendor.id, paymentDate: new Date(input.date), method: input.method, fromAccountNumber: input.fromAccountNumber, amount: input.amount, allocations, settlementRate: input.settlementRate ?? null, reference: input.reference ?? null, withheldTax: withheld, journalEntryId: entry.id, createdByUserId: context.userId },
    });
    for (const { bill, paid } of touched) await changeDoc(tx, context, bill, { amountPaid: paid, status: paidStatus(rates, bill, paid) }, 'bill.payment_applied');
    await audited(tx, context, 'vendor_payment.recorded', 'vendor_payment', p.id);
    return { id: p.id, number };
  });
}

// ---- vendor credits ---------------------------------------------------------------------------------
export async function createVendorCredit(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const vendor = await vendorOf(tx, context, input.vendorId);
    if (input.billId && (await docOf(tx, context, input.billId, 'bill')).vendorId !== vendor.id) throw new EmrError('VALIDATION_FAILED', { message: 'That bill belongs to another vendor.' });
    const lines = await cleanLines(tx, context, input.lines, rates);
    const vc = await createDoc(tx, context, 'vendor-credit', 'vendor-credit', { ...(input.id ? { id: input.id } : {}), vendorId: vendor.id, sourceDocId: input.billId ?? null, docDate: new Date(input.date), lines, reason: input.reason, status: 'Open' });
    const jl = [
      ...lines.map((l) => ({ accountNumber: l.accountNumber, debit: 0, credit: lineAmount(l), description: l.description, vendorId: vendor.id })),
      ...docTaxBreakdown(rates, lines).filter((b) => b.amount > 0).map((b) => ({ accountNumber: b.accountNumber, debit: 0, credit: b.amount, description: `Input ${b.label} reversed — ${vc.number}`, vendorId: vendor.id })),
    ];
    jl.unshift({ accountNumber: vendor.apAccountNumber, debit: round2(jl.reduce((n, l) => n + l.credit, 0)), credit: 0, description: `${vc.number} — ${vendor.name}`, vendorId: vendor.id });
    const entry = await postEntry(tx, context, { date: vc.docDate, source: 'Vendor Credit', memo: `Vendor credit ${vc.number} — ${vendor.name}`, reference: vc.number, lines: jl });
    await tx.acctPurchaseDoc.updateMany({ where: { ...org(context), id: vc.id }, data: { journalEntryId: entry.id } });
    await audited(tx, context, 'vendor_credit.recorded', 'vendor_credit', vc.id);
    return { id: vc.id, number: vc.number };
  });
}
export async function applyVendorCredit(context, id, { billId, amount }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const vc = await docOf(tx, context, id, 'vendor-credit');
    const bill = await docOf(tx, context, billId, 'bill');
    if (vc.status === 'Applied') throw new EmrError('INVALID_STATE', { message: 'This vendor credit has been used up.' });
    if (bill.vendorId !== vc.vendorId) throw new EmrError('VALIDATION_FAILED', { message: 'A vendor credit applies only to the same vendor\'s bills.' });
    if (!OPEN_BILL.includes(bill.status)) throw new EmrError('INVALID_STATE', { message: `${bill.number} is not open.` });
    if (bill.currency !== 'NGN') throw new EmrError('INVALID_STATE', { message: 'Vendor credits apply to naira bills.' });
    const used = Number((await tx.acctVendorCreditApplication.aggregate({ where: { ...org(context), vendorCreditId: id }, _sum: { amount: true } }))._sum.amount ?? 0);
    const left = round2(total(rates, vc) - used);
    if (amount > left + 0.01 || amount > billBalance(rates, bill) + 0.01) throw new EmrError('VALIDATION_FAILED', { message: 'That is more than is left on the credit or the bill.' });
    await tx.acctVendorCreditApplication.create({ data: { ...org(context), vendorCreditId: id, billId, amount, appliedByUserId: context.userId } });
    const paid = round2(Number(bill.amountPaid) + amount);
    await changeDoc(tx, context, bill, { amountPaid: paid, status: paidStatus(rates, bill, paid) }, 'bill.credit_applied');
    await changeDoc(tx, context, vc, { status: left - amount <= 0.01 ? 'Applied' : 'Partially Applied' }, 'vendor_credit.applied');
    return { id };
  });
}

// ---- recurring bills, FX revaluation ----------------------------------------------------------------
export async function runRecurringBills(context, { asOf }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const when = new Date(asOf);
    const due = await tx.acctPurchaseDoc.findMany({ where: { ...org(context), kind: 'bill', recurEveryMonths: { not: null }, recurNextDate: { lte: when }, status: { not: 'Void' } } });
    const created = [];
    for (const src of due) {
      let next = src.recurNextDate;
      while (next <= when && (!src.recurEndDate || next <= src.recurEndDate)) {
        const bill = await createBillInTx(tx, context, { vendorId: src.vendorId, date: next, lines: src.lines, notes: `Recurring from ${src.number}`, currency: src.currency, exchangeRate: Number(src.exchangeRate) });
        const entry = await postBillInTx(tx, context, bill);
        await changeDoc(tx, context, bill, { status: 'Awaiting Payment', journalEntryId: entry.id, postedAt: new Date() }, 'bill.posted');
        created.push(bill.id);
        next = monthsAdd(next, src.recurEveryMonths);
      }
      await tx.acctPurchaseDoc.updateMany({ where: { ...org(context), id: src.id }, data: { recurNextDate: next, version: { increment: 1 } } });
    }
    return { created };
  });
}
export async function revalueForeign(context, { asOf, rates: newRates }) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    const rates = await taxRates(tx, context);
    const open = await tx.acctPurchaseDoc.findMany({ where: { ...org(context), kind: 'bill', currency: { not: 'NGN' }, status: { in: OPEN_BILL } } });
    let adjusted = 0; let net = 0;
    for (const bill of open) {
      const to = newRates[bill.currency];
      const from = Number(bill.exchangeRate);
      if (!to || Math.abs(to - from) < 0.005) continue;
      const delta = round2(billBalance(rates, bill) * (to - from)); // what is owed goes up when the rate rises
      if (Math.abs(delta) < 0.005) continue;
      const vendor = await vendorOf(tx, context, bill.vendorId);
      await postEntry(tx, context, {
        date: new Date(asOf), source: 'FX Revaluation', memo: `FX revaluation — ${bill.number} (${bill.currency} ${from} → ${to})`, reference: bill.number,
        lines: delta > 0
          ? [{ accountNumber: ACCT.fxLoss, debit: delta, credit: 0, description: 'Unrealised FX loss' }, { accountNumber: vendor.apAccountNumber, debit: 0, credit: delta, vendorId: vendor.id }]
          : [{ accountNumber: vendor.apAccountNumber, debit: -delta, credit: 0, vendorId: vendor.id }, { accountNumber: ACCT.fxGain, debit: 0, credit: -delta, description: 'Unrealised FX gain' }],
      });
      await changeDoc(tx, context, bill, { exchangeRate: to }, 'bill.revalued');
      adjusted += 1; net = round2(net + delta);
    }
    return { module: 'AP', adjusted, net };
  });
}
