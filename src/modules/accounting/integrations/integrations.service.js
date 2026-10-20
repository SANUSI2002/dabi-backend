// Integrations: the books follow the organization's other Sabi records, read server-side inside the same
// tenant (nothing crosses organizations, nothing is sent anywhere).
//
//   - EMR billing → receivables: each issued EMR invoice becomes an issued receivables invoice for the
//     patient (one customer per patient, named and numbered from the registry — no clinical detail), one
//     line per charge on the revenue account for its category, any discount on Discounts & Waivers; each
//     posted payment becomes a receipt against it; a reversed payment voids its receipt and a voided EMR
//     invoice voids its accounting invoice.
//   - Payroll → ledger: confirmed payslips accrue (Dr Salaries, Cr PAYE / Pension / NHF / staff loans /
//     other deductions / Salaries Payable), one entry per batch per sync; paid payslips settle the net pay
//     from the bank.
//   - Pharmacy → inventory: dispensed quantities (less returns) relieve Drug Inventory to Cost of Drugs
//     Sold at the dispensed batch's unit cost; a batch without a recorded cost is reported, not guessed.
//
// Every source record is posted once (acct_integration_events), each in its own transaction, so one bad
// record never blocks the rest and a sync can be repeated safely. acct.view reads the status; acct.post
// runs a sync.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { EmrError } from '../../emr/core/errors.js';
import { ensureBooks, postEntry, requireAcct, round2 } from '../ledger/ledger.service.js';
import { taxRates } from '../settings/settings.service.js';
import { addCustomerInTx, createInvoiceInTx, issueInvoiceInTx, recordReceiptInTx, voidDocInTx, voidReceiptInTx } from '../receivables/receivables.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const minor = (v) => round2(Number(v) / 100);
const ACCT = { cashOnHand: 1000, bank: 1010, staffAdvances: 1400, drugInventory: 1200, accruals: 2100, salariesPayable: 2120, payePayable: 2300, pensionPayable: 2310, nhfPayable: 2320, discounts: 4900, cogsDrugs: 5000, salaries: 5100 };
const REVENUE = { CONSULTATION: 4000, LAB: 4010, MEDICATION: 4020, PROCEDURE: 4030, BED_DAY: 4040, IMAGING: 4050, OTHER: 4000 };
const DEPOSIT = { CASH: [ACCT.cashOnHand, 'Cash'], POS: [ACCT.bank, 'POS'], CARD: [ACCT.bank, 'POS'], BANK_TRANSFER: [ACCT.bank, 'Bank Transfer'], MOBILE_MONEY: [ACCT.bank, 'Bank Transfer'], CHEQUE: [ACCT.bank, 'Cheque'] };
const EXEMPT = 'tax-vat-exempt';

// ---- the record of what was posted ------------------------------------------------------------------
const key = (context, kind, sourceRef) => ({ organizationId_kind_sourceRef: { organizationId: context.organizationId, kind, sourceRef } });
const eventOf = (tx, context, kind, sourceRef) => tx.acctIntegrationEvent.findUnique({ where: key(context, kind, sourceRef) });
const mark = (tx, context, kind, sourceRef, data = {}, journalEntryId = null) => tx.acctIntegrationEvent.upsert({
  where: key(context, kind, sourceRef), create: { ...org(context), kind, sourceRef, data, journalEntryId }, update: { data, journalEntryId, updatedAt: new Date() },
});
async function refsOf(tx, context, kind) {
  return new Map((await tx.acctIntegrationEvent.findMany({ where: { ...org(context), kind } })).map((e) => [e.sourceRef, e]));
}
/** Runs one record's posting in a transaction of its own; a failure is reported, the rest carry on. */
async function each(context, result, label, work) {
  try {
    const posted = await withTenant(context, work);
    if (posted === 'skipped') result.skipped += 1;
    else if (posted) result.created += 1;
  } catch (error) {
    result.errors.push(`${label}: ${error instanceof EmrError ? error.message : 'could not be posted'}`);
  }
}
const classify = (name) => {
  const n = name.toLowerCase();
  if (n.includes('paye') || n.includes('p.a.y.e') || (n.includes('tax') && !n.includes('nhf'))) return 'paye';
  if (n.includes('pension')) return 'pension';
  if (n.includes('nhf') || n.includes('housing fund')) return 'nhf';
  if (n.includes('loan') || n.includes('advance')) return 'loan';
  return 'other';
};

// ---- what is waiting ---------------------------------------------------------------------------------
async function pendingWork(tx, context) {
  const [invoices, payments, slips, lines, events] = await Promise.all([
    tx.emrInvoice.findMany({ where: org(context), select: { id: true, status: true } }),
    tx.emrPayment.findMany({ where: org(context), select: { id: true, status: true, invoiceId: true } }),
    tx.wfPayslip.findMany({ where: { ...org(context), status: { in: ['Confirmed', 'Paid'] } }, select: { id: true, batch: true, status: true } }),
    tx.emrDispenseLine.findMany({ where: org(context), select: { id: true, quantity: true, quantityReturned: true } }),
    tx.acctIntegrationEvent.findMany({ where: org(context), select: { kind: true, sourceRef: true, data: true } }),
  ]);
  const has = new Map();
  for (const e of events) has.set(`${e.kind}:${e.sourceRef}`, e);
  const done = (kind, ref) => has.has(`${kind}:${ref}`);
  const billing = [
    ...invoices.filter((i) => i.status !== 'VOID' && !done('emr-invoice', i.id)),
    ...invoices.filter((i) => i.status === 'VOID' && done('emr-invoice', i.id) && !done('emr-invoice-void', i.id)),
    ...payments.filter((p) => p.status === 'POSTED' && !done('emr-payment', p.id)),
    ...payments.filter((p) => p.status === 'REVERSED' && done('emr-payment', p.id) && !done('emr-payment-reversal', p.id)),
  ].length;
  const accrual = new Set(slips.filter((s) => !done('payslip-accrual', s.id)).map((s) => s.batch)).size;
  const settlement = new Set(slips.filter((s) => s.status === 'Paid' && done('payslip-accrual', s.id) && !done('payslip-paid', s.id)).map((s) => s.batch)).size;
  const pharmacy = lines.filter((l) => {
    const e = has.get(`dispense-line:${l.id}`);
    return !e || (e.data.costed !== false && e.data.qty !== l.quantity - l.quantityReturned);
  }).length;
  return { emrBilling: billing, payrollAccrual: accrual, payrollSettlement: settlement, pharmacy };
}
export async function status(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    const last = await tx.acctIntegrationEvent.findFirst({ where: org(context), orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } });
    return { pending: await pendingWork(tx, context), lastSyncAt: last?.updatedAt ?? null };
  });
}

// ---- EMR billing → receivables -----------------------------------------------------------------------
async function customerFor(tx, context, patientId) {
  const e = await eventOf(tx, context, 'emr-patient', patientId);
  if (e) return e.data.customerId;
  const p = await tx.emrPatient.findFirst({ where: { ...org(context), id: patientId }, select: { givenName: true, familyName: true, medicalRecordNumber: true } });
  if (!p) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'The patient is not in the registry.' });
  const c = await addCustomerInTx(tx, context, { name: `${p.givenName} ${p.familyName} — ${p.medicalRecordNumber}`.slice(0, 160), type: 'Patient', paymentTermsDays: 0 });
  await mark(tx, context, 'emr-patient', patientId, { customerId: c.id });
  return c.id;
}
async function syncBilling(context, result) {
  const { invoices, payments, events } = await withTenant(context, async (tx) => ({
    invoices: await tx.emrInvoice.findMany({ where: org(context), orderBy: { issuedAt: 'asc' } }),
    payments: await tx.emrPayment.findMany({ where: org(context), orderBy: { receivedAt: 'asc' } }),
    events: { invoice: await refsOf(tx, context, 'emr-invoice'), invoiceVoid: await refsOf(tx, context, 'emr-invoice-void'), payment: await refsOf(tx, context, 'emr-payment'), reversal: await refsOf(tx, context, 'emr-payment-reversal') },
  }));
  // reversals first, so a voided invoice has nothing left applied to it
  for (const p of payments.filter((x) => x.status === 'REVERSED' && events.payment.has(x.id) && !events.reversal.has(x.id))) {
    await each(context, result, `Receipt ${p.receiptNumber} reversal`, async (tx) => {
      await voidReceiptInTx(tx, context, events.payment.get(p.id).data.receiptId, `Payment ${p.receiptNumber} reversed in EMR billing`);
      await mark(tx, context, 'emr-payment-reversal', p.id);
      return true;
    });
  }
  for (const inv of invoices.filter((x) => x.status !== 'VOID' && !events.invoice.has(x.id))) {
    await each(context, result, `EMR invoice ${inv.number}`, async (tx) => {
      const rates = await taxRates(tx, context);
      const charges = await tx.emrCharge.findMany({ where: { ...org(context), invoiceId: inv.id, status: { not: 'VOIDED' } }, orderBy: { serviceAt: 'asc' } });
      const taxFor = (bp) => {
        if (!bp) return EXEMPT;
        const r = [...rates.values()].find((x) => x.isActive && Math.round(x.rate * 100) === bp);
        if (!r) throw new EmrError('VALIDATION_FAILED', { message: `No tax rate of ${bp / 100}% is set up in Accounting.` });
        return r.id;
      };
      const lines = charges.map((c) => ({ accountNumber: REVENUE[c.category] ?? REVENUE.OTHER, description: c.description.slice(0, 300), qty: c.quantity, unitPrice: minor(c.unitPriceMinor), taxRateId: taxFor(c.taxRateBp) }));
      if (Number(inv.discountMinor) > 0) lines.push({ accountNumber: ACCT.discounts, description: `Discount${inv.discountReason ? ` — ${inv.discountReason}` : ''}`.slice(0, 300), qty: 1, unitPrice: -minor(inv.discountMinor), taxRateId: EXEMPT });
      if (!lines.length) { await mark(tx, context, 'emr-invoice', inv.id, { skipped: 'no charges' }); return 'skipped'; }
      const customerId = await customerFor(tx, context, inv.patientId);
      const doc = await createInvoiceInTx(tx, context, { customerId, date: inv.issuedAt, dueDate: inv.dueDate ?? undefined, lines, notes: `From EMR ${inv.number}`, currency: inv.currency, source: 'EMR Billing', sourceRef: inv.id });
      const issued = await issueInvoiceInTx(tx, context, doc.id);
      const expected = minor(inv.totalMinor);
      const posted = round2(lines.reduce((n, l) => n + l.qty * l.unitPrice, 0) + charges.reduce((n, c) => n + minor(c.taxMinor), 0));
      if (Math.abs(posted - expected) > 0.01) throw new EmrError('INVALID_STATE', { message: `Its charges come to ${posted.toLocaleString('en-NG')}, not the invoice total ${expected.toLocaleString('en-NG')}.` });
      await mark(tx, context, 'emr-invoice', inv.id, { invoiceId: doc.id, customerId }, issued.journalEntryId);
      events.invoice.set(inv.id, { data: { invoiceId: doc.id, customerId } });
      return true;
    });
  }
  for (const p of payments.filter((x) => x.status === 'POSTED' && !events.payment.has(x.id))) {
    const link = events.invoice.get(p.invoiceId);
    if (!link?.data.invoiceId) { result.errors.push(`Receipt ${p.receiptNumber}: its invoice is not in the books yet`); continue; }
    await each(context, result, `Receipt ${p.receiptNumber}`, async (tx) => {
      const [depositAccountNumber, method] = DEPOSIT[p.method] ?? DEPOSIT.CASH;
      const amount = minor(p.amountMinor);
      const r = await recordReceiptInTx(tx, context, { customerId: link.data.customerId, date: p.transactionDate ?? p.receivedAt, method, depositAccountNumber, amount, allocations: [{ invoiceId: link.data.invoiceId, amount }], reference: p.receiptNumber });
      await mark(tx, context, 'emr-payment', p.id, { receiptId: r.id });
      return true;
    });
  }
  for (const inv of invoices.filter((x) => x.status === 'VOID' && events.invoice.has(x.id) && !events.invoiceVoid.has(x.id))) {
    await each(context, result, `EMR invoice ${inv.number} void`, async (tx) => {
      const { invoiceId } = events.invoice.get(inv.id).data;
      if (invoiceId) await voidDocInTx(tx, context, 'invoice', invoiceId);
      await mark(tx, context, 'emr-invoice-void', inv.id);
      return true;
    });
  }
}

// ---- payroll → ledger -------------------------------------------------------------------------------
async function syncPayroll(context, result) {
  const { slips, accrued, paid } = await withTenant(context, async (tx) => ({
    slips: await tx.wfPayslip.findMany({ where: { ...org(context), status: { in: ['Confirmed', 'Paid'] } } }),
    accrued: await refsOf(tx, context, 'payslip-accrual'), paid: await refsOf(tx, context, 'payslip-paid'),
  }));
  const byBatch = (list) => [...new Set(list.map((s) => s.batch))].map((batch) => [batch, list.filter((s) => s.batch === batch)]);
  for (const [batch, ready] of byBatch(slips.filter((s) => !accrued.has(s.id)))) {
    await each(context, result, `Payroll ${batch} accrual`, async (tx) => {
      const gross = round2(ready.reduce((n, s) => n + Number(s.grossPay), 0));
      const net = round2(ready.reduce((n, s) => n + Number(s.netPay), 0));
      const sums = { paye: 0, pension: 0, nhf: 0, loan: 0, other: 0 };
      for (const d of ready.flatMap((s) => s.deductions)) sums[classify(d.name)] = round2(sums[classify(d.name)] + Number(d.amount));
      const lines = [
        { accountNumber: ACCT.salaries, debit: gross, credit: 0, description: `Payroll — ${batch} (${ready.length} staff)` },
        ...(sums.paye > 0 ? [{ accountNumber: ACCT.payePayable, debit: 0, credit: sums.paye, description: 'PAYE withheld' }] : []),
        ...(sums.pension > 0 ? [{ accountNumber: ACCT.pensionPayable, debit: 0, credit: sums.pension, description: 'Pension withheld' }] : []),
        ...(sums.nhf > 0 ? [{ accountNumber: ACCT.nhfPayable, debit: 0, credit: sums.nhf, description: 'NHF withheld' }] : []),
        ...(sums.loan > 0 ? [{ accountNumber: ACCT.staffAdvances, debit: 0, credit: sums.loan, description: 'Staff loan recovery' }] : []),
        ...(sums.other > 0.005 ? [{ accountNumber: ACCT.accruals, debit: 0, credit: sums.other, description: 'Other payroll deductions' }] : []),
        { accountNumber: ACCT.salariesPayable, debit: 0, credit: net, description: 'Net pay owed to staff' },
      ];
      const entry = await postEntry(tx, context, { date: ready[0].endDate, source: 'Payroll', memo: `Payroll accrual — ${batch}`, reference: batch.slice(0, 100), lines });
      for (const s of ready) await mark(tx, context, 'payslip-accrual', s.id, { batch }, entry.id);
      for (const s of ready) accrued.set(s.id, true);
      return true;
    });
  }
  for (const [batch, done] of byBatch(slips.filter((s) => s.status === 'Paid' && accrued.has(s.id) && !paid.has(s.id)))) {
    await each(context, result, `Payroll ${batch} settlement`, async (tx) => {
      const net = round2(done.reduce((n, s) => n + Number(s.netPay), 0));
      const date = done.map((s) => s.paidAt).filter(Boolean).sort((a, b) => b - a)[0] ?? new Date();
      const entry = await postEntry(tx, context, {
        date, source: 'Payroll', memo: `Salaries paid — ${batch}`, reference: batch.slice(0, 100),
        lines: [{ accountNumber: ACCT.salariesPayable, debit: net, credit: 0, description: 'Clear net pay liability' }, { accountNumber: ACCT.bank, debit: 0, credit: net, description: `Salary payment run — ${batch}` }],
      });
      for (const s of done) await mark(tx, context, 'payslip-paid', s.id, { batch }, entry.id);
      return true;
    });
  }
}

// ---- pharmacy → inventory ---------------------------------------------------------------------------
async function syncPharmacy(context, result) {
  const { lines, posted } = await withTenant(context, async (tx) => ({
    lines: await tx.emrDispenseLine.findMany({ where: org(context), include: { dispense: { select: { dispensedAt: true } } } }),
    posted: await refsOf(tx, context, 'dispense-line'),
  }));
  for (const l of lines) {
    const net = l.quantity - l.quantityReturned;
    const before = posted.get(l.id);
    if (before && (before.data.costed === false || before.data.qty === net)) continue;
    await each(context, result, `Dispense line ${l.id.slice(0, 8)}`, async (tx) => {
      const batch = await tx.emrStockBatch.findFirst({ where: { ...org(context), id: l.batchId }, select: { batchNumber: true, unitCostMinor: true } });
      if (!batch || batch.unitCostMinor === null) {
        // no cost on record: say so rather than guess one (re-run once the batch has a cost)
        await mark(tx, context, 'dispense-line', l.id, { qty: net, costed: false });
        result.errors.push(`Batch ${batch?.batchNumber ?? l.batchId.slice(0, 8)} has no unit cost recorded; its dispense was not costed`);
        return 'skipped';
      }
      const delta = net - (before?.data.qty ?? 0);
      const amount = round2(Math.abs(delta) * minor(batch.unitCostMinor));
      let entryId = before?.journalEntryId ?? null;
      if (amount > 0) {
        const out = delta > 0;
        const entry = await postEntry(tx, context, {
          date: out ? l.dispense.dispensedAt : new Date(), source: 'Inventory', memo: `${out ? 'Drugs dispensed' : 'Drugs returned to pharmacy'} — batch ${batch.batchNumber}`, reference: batch.batchNumber.slice(0, 100),
          lines: out
            ? [{ accountNumber: ACCT.cogsDrugs, debit: amount, credit: 0, description: `${delta} unit(s) dispensed` }, { accountNumber: ACCT.drugInventory, debit: 0, credit: amount, description: 'Drug inventory relieved' }]
            : [{ accountNumber: ACCT.drugInventory, debit: amount, credit: 0, description: `${-delta} unit(s) returned` }, { accountNumber: ACCT.cogsDrugs, debit: 0, credit: amount, description: 'Cost of drugs reversed' }],
        });
        entryId = entry.id;
      }
      await mark(tx, context, 'dispense-line', l.id, { qty: net, unitCostMinor: Number(batch.unitCostMinor) }, entryId);
      return amount > 0;
    });
  }
}

// ---- running a sync ---------------------------------------------------------------------------------
const MODULES = { 'EMR Billing': syncBilling, Payroll: syncPayroll, Pharmacy: syncPharmacy };
export async function sync(context, { modules }) {
  requireAcct(context, 'acct.post');
  await withTenant(context, (tx) => ensureBooks(tx, context));
  const results = [];
  for (const module of modules) {
    const result = { module, created: 0, skipped: 0, errors: [] };
    await MODULES[module](context, result);
    results.push(result);
  }
  await withTenant(context, (tx) => recordAudit(tx, context, { action: 'integrations.synced', resourceType: 'integration', changedFields: results.map((r) => `${r.module}:${r.created}`) }));
  return { results, ...(await status(context)) };
}
