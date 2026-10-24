// Finance documents built from the books: invoice copies, customer and supplier statements of account,
// and remittance advice — as data for the screens and as PDF for printing and email.
//
// Statements come from the subledger: posted journal lines tagged with the customer (or vendor) on the
// receivable (or payable) accounts, so opening balances, unapplied cash, credit notes, refunds and FX
// revaluations all appear and the closing balance ties to the ledger. Ageing is from the open invoices
// (or bills) and is shown only for a statement that runs to today, since it describes the present.
// acct.view reads all of these.
import { withTenant } from '../../emr/core/db.js';
import { EmrError } from '../../emr/core/errors.js';
import { requireAcct, round2 } from '../ledger/ledger.service.js';
import { docSubtotal, docTaxBreakdown, docTotal, ensureSettings, lineAmount, taxRates } from '../settings/settings.service.js';
import { senderFor } from '../email/customerEmail.js';
import { renderInvoicePdf, renderRemittancePdf, renderStatementPdf } from './financePdf.js';

const org = (context) => ({ organizationId: context.organizationId });
const notFound = (what) => new EmrError('HR_RECORD_NOT_FOUND', { message: `${what} not found.` });
const AR_ACCOUNTS = [1100, 1110, 1120];
const OPEN_INVOICE = ['Open', 'Partially Paid'];
const OPEN_BILL = ['Awaiting Payment', 'Partially Paid'];
const DAY = 86_400_000;
const STATEMENT_DAYS = 90;

/** The hospital as it appears on its documents: the accounting profile, else the facility's name. */
export function issuerOf(settings, sender) {
  const p = settings.orgProfile ?? {};
  return {
    name: p.tradingName || p.legalName || sender.hospitalName, address: p.address || '', phone: p.phone || '', email: p.email || '',
    tin: p.tin || '', rcNumber: p.rcNumber || '', paymentInstructions: p.paymentInstructions || '',
  };
}
export const fileSafe = (s) => String(s).replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 80);
const ymd = (d) => d.toISOString().slice(0, 10);

// ---- invoices ---------------------------------------------------------------------------------------
/** An invoice as printed: its lines, taxes, totals and what is left to pay. */
export function invoiceDocument(rates, inv) {
  const totalDue = docTotal(rates, inv.lines);
  const paid = round2(Number(inv.amountPaid));
  const overdue = OPEN_INVOICE.includes(inv.status) && inv.dueDate && inv.dueDate < new Date();
  return {
    number: inv.number, date: inv.docDate, dueDate: inv.dueDate, currency: inv.currency, notes: inv.notes ?? '',
    status: overdue ? 'Overdue' : inv.status, kindLabel: inv.status === 'Draft' ? 'Draft invoice' : inv.status === 'Void' ? 'Void invoice' : 'Invoice',
    lines: inv.lines.map((l) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: lineAmount(l) })),
    subtotal: docSubtotal(inv.lines), taxes: docTaxBreakdown(rates, inv.lines).filter((t) => t.amount > 0).map((t) => ({ label: t.label, amount: t.amount })),
    total: totalDue, paid, balance: round2(totalDue - paid),
  };
}
/** The PDF for an invoice, inside the caller's transaction. */
export async function invoicePdfInTx(tx, context, inv, sender) {
  const settings = await ensureSettings(tx, context);
  const cust = await tx.acctCustomer.findFirst({ where: { ...org(context), id: inv.customerId } });
  const bytes = await renderInvoicePdf({ issuer: issuerOf(settings, sender), customer: partyOf(cust), invoice: invoiceDocument(await taxRates(tx, context), inv) });
  return { filename: `${fileSafe(inv.number)}.pdf`, bytes };
}
export async function invoicePdf(context, id) {
  requireAcct(context, 'acct.view');
  const sender = await senderFor(context);
  return withTenant(context, async (tx) => {
    const inv = await tx.acctSalesDoc.findFirst({ where: { ...org(context), id, kind: 'invoice' } });
    if (!inv) throw notFound('Invoice');
    return invoicePdfInTx(tx, context, inv, sender);
  });
}
const partyOf = (p) => ({ name: p?.name ?? 'Unknown', address: p?.address ?? '', city: p?.city ?? '', email: p?.email ?? '', phone: p?.phone ?? '' });

// ---- statements -------------------------------------------------------------------------------------
/** A period: `from`/`to` as given, else the last 90 days to today. Dates are whole UTC days. */
export function periodOf({ from, to } = {}) {
  const end = to ? new Date(to) : new Date();
  const toDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 23, 59, 59, 999));
  const start = from ? new Date(from) : new Date(toDay.getTime() - STATEMENT_DAYS * DAY);
  const fromDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime()) || fromDay > toDay) throw new EmrError('VALIDATION_FAILED', { message: 'The statement period must start on or before its end.' });
  return { from: fromDay, to: toDay };
}
/**
 * A party's subledger on its control accounts: the balance before `from`, then each posted line in the
 * period with a running balance. `sign` is +1 when debits increase what is owed (customers), -1 for vendors.
 */
async function partyLedger(tx, context, { column, partyId, accounts, from, to, sign }) {
  const col = column === 'vendor' ? 'vendor_id' : 'customer_id';
  const [opening] = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(l."debit" - l."credit"), 0) AS "net" FROM "acct_journal_lines" l
       JOIN "acct_journal_entries" e ON e."organization_id" = l."organization_id" AND e."id" = l."entry_id"
     WHERE l."organization_id" = $1 AND l."${col}" = $2 AND l."account_number" = ANY($3::int[]) AND e."status" IN ('Posted', 'Reversed') AND e."entry_date" < $4`,
    context.organizationId, partyId, accounts, from,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT e."entry_date" AS "date", e."number" AS "entryNumber", e."reference", e."memo", e."source", l."description", l."debit", l."credit"
       FROM "acct_journal_lines" l JOIN "acct_journal_entries" e ON e."organization_id" = l."organization_id" AND e."id" = l."entry_id"
     WHERE l."organization_id" = $1 AND l."${col}" = $2 AND l."account_number" = ANY($3::int[]) AND e."status" IN ('Posted', 'Reversed') AND e."entry_date" >= $4 AND e."entry_date" <= $5
     ORDER BY e."entry_date", e."created_at", l."line_no"`,
    context.organizationId, partyId, accounts, from, to,
  );
  const openingBalance = round2(sign * Number(opening.net));
  let running = openingBalance;
  const lines = rows.map((r) => {
    const debit = round2(Number(r.debit)); const credit = round2(Number(r.credit));
    running = round2(running + sign * (debit - credit));
    return { date: r.date, reference: r.reference ?? r.entryNumber, description: r.memo || r.description || r.source, debit, credit, balance: running };
  });
  return { openingBalance, closingBalance: running, lines, totalDebits: round2(lines.reduce((n, l) => n + l.debit, 0)), totalCredits: round2(lines.reduce((n, l) => n + l.credit, 0)) };
}
const BUCKETS = [['Current', -Infinity, 0], ['1-30 days', 1, 30], ['31-60 days', 31, 60], ['61-90 days', 61, 90], ['Over 90 days', 91, Infinity]];
/** Ageing of open documents by days past due, in naira; anything owed that no document explains is shown apart. */
function ageing(open, closingBalance) {
  const now = Date.now();
  const amounts = BUCKETS.map(() => 0);
  for (const o of open) {
    const late = o.dueDate ? Math.floor((now - new Date(o.dueDate).getTime()) / DAY) : 0;
    const i = BUCKETS.findIndex(([, lo, hi]) => late >= lo && late <= hi);
    amounts[i] = round2(amounts[i] + o.balanceNgn);
  }
  const rows = BUCKETS.map(([label], i) => ({ label, amount: amounts[i] }));
  const other = round2(closingBalance - amounts.reduce((n, a) => n + a, 0));
  if (Math.abs(other) >= 0.01) rows.push({ label: other > 0 ? 'Not on an invoice' : 'Unapplied credit', amount: other });
  return rows;
}
const runsToToday = (to) => to.getTime() >= Date.now() - DAY;

/** A customer's statement of account for a period. */
export async function customerStatementInTx(tx, context, customerId, period) {
  const cust = await tx.acctCustomer.findFirst({ where: { ...org(context), id: customerId } });
  if (!cust) throw notFound('Customer');
  const { from, to } = periodOf(period);
  const ledger = await partyLedger(tx, context, { column: 'customer', partyId: cust.id, accounts: [...new Set([...AR_ACCOUNTS, cust.arAccountNumber])], from, to, sign: 1 });
  let open = [];
  if (runsToToday(to)) {
    const rates = await taxRates(tx, context);
    const docs = await tx.acctSalesDoc.findMany({ where: { ...org(context), kind: 'invoice', customerId: cust.id, status: { in: OPEN_INVOICE } }, orderBy: { docDate: 'asc' } });
    open = docs.map((d) => {
      const t = docTotal(rates, d.lines); const balance = round2(t - Number(d.amountPaid));
      return { id: d.id, number: d.number, date: d.docDate, dueDate: d.dueDate, currency: d.currency, total: t, balance, balanceNgn: round2(balance * Number(d.exchangeRate)), overdue: Boolean(d.dueDate && d.dueDate < new Date()) };
    });
  }
  return {
    party: { id: cust.id, ...partyOf(cust) }, perspective: 'customer',
    statement: { from, to, currency: 'NGN', ...ledger, open, aging: runsToToday(to) ? ageing(open, ledger.closingBalance) : [] },
  };
}
/** A supplier's statement: what the hospital owes them, from the payable subledger. */
export async function vendorStatementInTx(tx, context, vendorId, period) {
  const vendor = await tx.acctVendor.findFirst({ where: { ...org(context), id: vendorId } });
  if (!vendor) throw notFound('Vendor');
  const { from, to } = periodOf(period);
  const ledger = await partyLedger(tx, context, { column: 'vendor', partyId: vendor.id, accounts: [vendor.apAccountNumber], from, to, sign: -1 });
  let open = [];
  if (runsToToday(to)) {
    const rates = await taxRates(tx, context);
    const bills = await tx.acctPurchaseDoc.findMany({ where: { ...org(context), kind: 'bill', vendorId: vendor.id, status: { in: OPEN_BILL } }, orderBy: { docDate: 'asc' } });
    open = bills.map((b) => {
      const t = docTotal(rates, b.lines); const balance = round2(t - Number(b.amountPaid));
      return { id: b.id, number: b.vendorInvoiceNumber ? `${b.number} (${b.vendorInvoiceNumber})` : b.number, date: b.docDate, dueDate: b.dueDate, currency: b.currency, total: t, balance, balanceNgn: round2(balance * Number(b.exchangeRate)), overdue: Boolean(b.dueDate && b.dueDate < new Date()) };
    });
  }
  return {
    party: { id: vendor.id, ...partyOf(vendor) }, perspective: 'vendor',
    statement: { from, to, currency: 'NGN', ...ledger, open, aging: runsToToday(to) ? ageing(open, ledger.closingBalance) : [] },
  };
}
/** The PDF of a statement already built. */
export async function statementPdf(settings, sender, built) {
  const bytes = await renderStatementPdf({ issuer: issuerOf(settings, sender), party: built.party, statement: built.statement, perspective: built.perspective });
  return { filename: `Statement-${fileSafe(built.party.name)}-${ymd(built.statement.to)}.pdf`, bytes };
}
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? undefined);
const present = (built) => ({
  party: built.party,
  ...built.statement, from: iso(built.statement.from), to: iso(built.statement.to),
  lines: built.statement.lines.map((l) => ({ ...l, date: iso(l.date) })),
  open: built.statement.open.map((o) => ({ ...o, date: iso(o.date), dueDate: iso(o.dueDate) })),
});

/** A statement for the screens (format "json") or as a PDF download. */
export async function partyStatement(context, kind, id, { from, to, format = 'json' } = {}) {
  requireAcct(context, 'acct.view');
  const sender = format === 'pdf' ? await senderFor(context) : null;
  return withTenant(context, async (tx) => {
    const built = kind === 'vendor' ? await vendorStatementInTx(tx, context, id, { from, to }) : await customerStatementInTx(tx, context, id, { from, to });
    if (format !== 'pdf') return present(built);
    return statementPdf(await ensureSettings(tx, context), sender, built);
  });
}

// ---- remittance advice ------------------------------------------------------------------------------
/** Remittance advice for a posted vendor payment: which bills it settled, and any tax withheld. */
export async function remittancePdf(context, paymentId) {
  requireAcct(context, 'acct.view');
  const sender = await senderFor(context);
  return withTenant(context, async (tx) => {
    const p = await tx.acctVendorPayment.findFirst({ where: { ...org(context), id: paymentId } });
    if (!p) throw notFound('Payment');
    if (p.status !== 'Posted') throw new EmrError('INVALID_STATE', { message: 'Remittance advice is available once the payment is posted.' });
    const vendor = await tx.acctVendor.findFirst({ where: { ...org(context), id: p.vendorId } });
    const bills = new Map((await tx.acctPurchaseDoc.findMany({ where: { ...org(context), kind: 'bill', id: { in: p.allocations.map((a) => a.billId) } } })).map((b) => [b.id, b]));
    const settings = await ensureSettings(tx, context);
    const bytes = await renderRemittancePdf({
      issuer: issuerOf(settings, sender), vendor: partyOf(vendor),
      payment: {
        number: p.number, date: p.paymentDate, method: p.method, reference: p.reference ?? '', amount: Number(p.amount), withheldTax: Number(p.withheldTax), currency: 'NGN',
        allocations: p.allocations.map((a) => { const b = bills.get(a.billId); return { number: b?.number ?? '', vendorInvoiceNumber: b?.vendorInvoiceNumber ?? '', date: b?.docDate, amount: a.amount }; }),
      },
    });
    return { filename: `Remittance-${fileSafe(p.number)}.pdf`, bytes };
  });
}
