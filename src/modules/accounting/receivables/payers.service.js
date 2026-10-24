// Healthcare payers and credit risk in receivables.
//
//   - Billing a payer: an HMO- or NHIA-covered patient's invoice (often from EMR billing) is billed, in
//     full or in part, to their payer: a payer invoice for that amount (with the authorization code and
//     enrollee number), and a journal entry moving the receivable — Dr the payer's receivable, Cr the
//     patient's. The patient's invoice is settled by that much. A transfer nothing has touched can be
//     reversed.
//   - Claims: a batch of the payer's open invoices for a period (each invoice in one open claim at most),
//     submitted with the payer's reference, then adjudicated: for each invoice, what the payer approved —
//     collected later as an ordinary receipt — and what it denied, either written off (Dr Claim Denials &
//     Contractual Adjustments) or, for a patient's charges, billed back to the patient (Dr patient
//     receivable); either way Cr the payer's receivable.
//   - Capitation: a payer's fixed payment per enrollee per month for months of cover — Dr the bank, Cr
//     Capitation Income for months already begun and Deferred Revenue for the rest, recognized as each
//     month begins.
//   - Write-offs: an uncollectable balance (acct.approve) is charged to the Allowance for Doubtful Debts as
//     far as it goes, the rest to Bad Debt Expense; a later recovery is Dr the bank, Cr Bad Debts Recovered.
//   - Expected credit loss (IFRS 9, simplified approach): the allowance is re-measured from a provision
//     matrix — a loss rate per days-past-due band, one for patients and one for payers — and the
//     difference posted to Bad Debt Expense (acct.approve). A preview posts nothing.
// acct.view reads; acct.post bills payers, prepares and adjudicates claims and records capitation.
import { randomUUID } from 'node:crypto';
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { postEntry, requireAcct, reverseInTx, round2, totalsByAccount } from '../ledger/ledger.service.js';
import { docTotal, dueDateFor, ensureSettings, nextDocNumber, taxRates } from '../settings/settings.service.js';
import { changeDoc, createDoc, customerOf, docOf } from './receivables.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
const PAYER_TYPES = ['NHIS', 'HMO'];
const OPEN = ['Open', 'Partially Paid'];
const ACCT = { allowance: 1190, capitation: 4060, recovered: 4120, denials: 4910, badDebt: 5700, deferred: 2400 };
const HEALTH_ACCOUNTS = [
  [ACCT.allowance, 'Allowance for Doubtful Debts', 'asset', 'contra_asset', false],
  [ACCT.capitation, 'Capitation Income', 'revenue', 'operating_revenue', true],
  [ACCT.recovered, 'Bad Debts Recovered', 'revenue', 'other_income', true],
  [ACCT.denials, 'Claim Denials & Contractual Adjustments', 'revenue', 'contra_revenue', true],
];
export const BANDS = ['Current', '1-30 days', '31-60 days', '61-90 days', 'Over 90 days'];
export const DEFAULT_LOSS_RATES = { patient: [2, 5, 15, 30, 60], payer: [1, 2, 5, 15, 35] };
const DAY = 86_400_000;
const iso = (d) => (d ? d.toISOString() : undefined);
const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const monthStart = (period) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1, 12)); };
const addMonths = (period, n) => { const d = monthStart(period); return ym(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))); };
const balanceOf = (rates, inv) => round2(docTotal(rates, inv.lines) - Number(inv.amountPaid));
const statusFor = (rates, inv, paid) => (paid >= docTotal(rates, inv.lines) - 0.01 ? 'Paid' : paid > 0.01 ? 'Partially Paid' : 'Open');
const notFound = (what) => new EmrError('HR_RECORD_NOT_FOUND', { message: `${what} not found.` });

/** The accounts payer and credit-loss entries post to, for books set up before they were in the chart. */
async function ensureHealthAccounts(tx, context) {
  await tx.acctAccount.createMany({
    data: HEALTH_ACCOUNTS.map(([number, name, type, subtype, allowManualEntry]) => ({ ...org(context), number, name, type, subtype, allowManualEntry, system: true })),
    skipDuplicates: true,
  });
}
async function payerOf(tx, context, id) {
  const p = await customerOf(tx, context, id);
  if (!PAYER_TYPES.includes(p.type)) throw new EmrError('VALIDATION_FAILED', { message: `${p.name} is not an HMO or NHIA payer.` });
  return p;
}
/** The allowance's credit balance on a date. */
async function allowanceBalance(tx, context, asOf) {
  const t = (await totalsByAccount(tx, context, { asOf })).get(ACCT.allowance);
  return t ? round2(t.credit - t.debit) : 0;
}

// ---- reading ----------------------------------------------------------------------------------------
export async function payersOverview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    await ensureSettings(tx, context);
    const [payers, transfers, claims, capitations, writeOffs, runs] = await Promise.all([
      tx.acctCustomer.findMany({ where: { ...org(context), type: { in: PAYER_TYPES } }, orderBy: { name: 'asc' }, select: { id: true, name: true, type: true } }),
      tx.acctPayerTransfer.findMany({ where: org(context), orderBy: { createdAt: 'desc' }, take: 500 }),
      tx.acctPayerClaim.findMany({ where: org(context), orderBy: { createdAt: 'desc' }, take: 200 }),
      tx.acctCapitation.findMany({ where: org(context), orderBy: { receivedDate: 'desc' }, take: 200 }),
      tx.acctWriteOff.findMany({ where: org(context), orderBy: { createdAt: 'desc' }, take: 500 }),
      tx.acctCreditLossRun.findMany({ where: org(context), orderBy: { createdAt: 'desc' }, take: 24 }),
    ]);
    const names = await userNameMap(tx, [...transfers, ...claims, ...capitations, ...writeOffs, ...runs].map((r) => r.createdByUserId));
    const who = (id) => names.get(id) ?? 'Former member';
    return {
      payers,
      transfers: transfers.map((t) => ({ id: t.id, patientInvoiceId: t.patientInvoiceId, payerInvoiceId: t.payerInvoiceId, patientCustomerId: t.patientCustomerId, payerCustomerId: t.payerCustomerId, amount: Number(t.amount), rebilledAmount: Number(t.rebilledAmount), authorizationCode: t.authorizationCode ?? undefined, enrolleeNumber: t.enrolleeNumber ?? undefined, journalEntryId: t.journalEntryId, createdBy: who(t.createdByUserId), createdAt: iso(t.createdAt), reversedAt: iso(t.reversedAt) })),
      claims: claims.map((c) => ({
        id: c.id, number: c.number, payerCustomerId: c.payerCustomerId, periodStart: iso(c.periodStart)?.slice(0, 10), periodEnd: iso(c.periodEnd)?.slice(0, 10), status: c.status, items: c.items, reference: c.reference ?? undefined, notes: c.notes ?? undefined,
        claimed: round2(c.items.reduce((n, i) => n + i.claimed, 0)), approved: c.status === 'Adjudicated' ? round2(c.items.reduce((n, i) => n + (i.approved ?? 0), 0)) : undefined, denied: c.status === 'Adjudicated' ? round2(c.items.reduce((n, i) => n + (i.denied ?? 0), 0)) : undefined,
        submittedAt: iso(c.submittedAt), adjudicatedAt: iso(c.adjudicatedAt), createdBy: who(c.createdByUserId), createdAt: iso(c.createdAt), version: c.version,
      })),
      capitations: capitations.map((c) => ({ id: c.id, number: c.number, payerCustomerId: c.payerCustomerId, startPeriod: c.startPeriod, months: c.months, enrollees: c.enrollees, ratePerEnrollee: Number(c.ratePerEnrollee), amount: Number(c.amount), receivedDate: iso(c.receivedDate)?.slice(0, 10), depositAccountNumber: c.depositAccountNumber, reference: c.reference ?? undefined, entries: c.entries, journalEntryId: c.journalEntryId, createdBy: who(c.createdByUserId), createdAt: iso(c.createdAt) })),
      writeOffs: writeOffs.map((w) => ({ id: w.id, invoiceId: w.invoiceId, customerId: w.customerId, amount: Number(w.amount), fromAllowance: Number(w.fromAllowance), reason: w.reason, recoveredAmount: Number(w.recoveredAmount), journalEntryId: w.journalEntryId, createdBy: who(w.createdByUserId), createdAt: iso(w.createdAt), version: w.version })),
      creditLossRuns: runs.map((r) => ({ id: r.id, asOf: iso(r.asOf)?.slice(0, 10), rates: r.rates, buckets: r.buckets, required: Number(r.required), previous: Number(r.previous), adjustment: Number(r.adjustment), journalEntryId: r.journalEntryId ?? undefined, createdBy: who(r.createdByUserId), createdAt: iso(r.createdAt) })),
      allowance: await allowanceBalance(tx, context, new Date()),
      bands: BANDS, defaultLossRates: runs[0]?.rates ?? DEFAULT_LOSS_RATES,
    };
  });
}

// ---- billing a payer --------------------------------------------------------------------------------
export async function billToPayer(context, invoiceId, { payerId, amount, authorizationCode, enrolleeNumber, id }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const settings = await ensureSettings(tx, context);
    const rates = await taxRates(tx, context);
    const inv = await docOf(tx, context, invoiceId, 'invoice');
    const patient = await customerOf(tx, context, inv.customerId);
    if (PAYER_TYPES.includes(patient.type)) throw new EmrError('VALIDATION_FAILED', { message: 'This invoice is already a payer\'s.' });
    if (!OPEN.includes(inv.status)) throw new EmrError('INVALID_STATE', { message: `${inv.number} is not open.` });
    if (inv.currency !== 'NGN') throw new EmrError('INVALID_STATE', { message: 'Only naira invoices are billed to payers.' });
    const payer = await payerOf(tx, context, payerId);
    const left = balanceOf(rates, inv);
    const amt = round2(amount ?? left);
    if (amt <= 0 || amt > left + 0.01) throw new EmrError('VALIDATION_FAILED', { message: `Bill at most the ${left.toLocaleString('en-NG')} left on ${inv.number}.` });
    const transferId = id ?? randomUUID();
    const now = new Date();
    const ref = [authorizationCode ? `auth ${authorizationCode}` : null, enrolleeNumber ? `enrollee ${enrolleeNumber}` : null].filter(Boolean).join(' · ');
    const payerInv = await createDoc(tx, context, 'invoice', {
      customerId: payer.id, docDate: now, dueDate: dueDateFor(settings, now, payer.paymentTermId, payer.paymentTermsDays), status: 'Open', issuedAt: now,
      lines: [{ id: `sl-${transferId.slice(0, 8)}`, accountNumber: patient.arAccountNumber, description: `${patient.name} — ${inv.number}${ref ? ` (${ref})` : ''}`, qty: 1, unitPrice: amt, taxRateId: 'tax-vat-exempt' }],
      notes: `Billed to ${payer.name} for ${patient.name}, invoice ${inv.number}.${ref ? ` ${ref}.` : ''}`, currency: 'NGN', exchangeRate: 1, source: 'Payer Bill', sourceRef: transferId,
    });
    const entry = await postEntry(tx, context, {
      date: now, source: 'Payer Transfer', reference: payerInv.number, memo: `${inv.number} billed to ${payer.name} — ${patient.name}`,
      lines: [
        { accountNumber: payer.arAccountNumber, debit: amt, credit: 0, description: `${payerInv.number} — ${patient.name}`, customerId: payer.id },
        { accountNumber: patient.arAccountNumber, debit: 0, credit: amt, description: `Billed to ${payer.name} (${payerInv.number})`, customerId: patient.id },
      ],
    });
    await tx.acctSalesDoc.updateMany({ where: { ...org(context), id: payerInv.id }, data: { journalEntryId: entry.id } });
    const paid = round2(Number(inv.amountPaid) + amt);
    await changeDoc(tx, context, inv, { amountPaid: paid, status: statusFor(rates, inv, paid) }, 'invoice.billed_to_payer');
    await tx.acctPayerTransfer.create({
      data: { id: transferId, ...org(context), patientInvoiceId: inv.id, payerInvoiceId: payerInv.id, patientCustomerId: patient.id, payerCustomerId: payer.id, amount: amt, authorizationCode: authorizationCode ?? null, enrolleeNumber: enrolleeNumber ?? null, journalEntryId: entry.id, createdByUserId: context.userId },
    });
    await audited(tx, context, 'payer_transfer.created', 'payer_transfer', transferId);
    return { id: transferId, payerInvoiceId: payerInv.id, payerInvoiceNumber: payerInv.number };
  });
}
/** Undoes a transfer nothing has touched: the payer invoice is voided and the patient owes it again. */
export async function reverseTransfer(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const t = await tx.acctPayerTransfer.findFirst({ where: { ...org(context), id } });
    if (!t) throw notFound('Transfer');
    if (t.reversedAt) throw new EmrError('INVALID_STATE', { message: 'This transfer is already reversed.' });
    const payerInv = await docOf(tx, context, t.payerInvoiceId, 'invoice');
    if (Number(payerInv.amountPaid) > 0) throw new EmrError('INVALID_STATE', { message: `${payerInv.number} has payments, credits or adjudications against it.` });
    const claimed = await tx.acctPayerClaim.findFirst({ where: { ...org(context), status: { in: ['Draft', 'Submitted'] }, items: { array_contains: [{ invoiceId: payerInv.id }] } } });
    if (claimed) throw new EmrError('INVALID_STATE', { message: `${payerInv.number} is on claim ${claimed.number}; take it off the claim first.` });
    const rates = await taxRates(tx, context);
    await reverseInTx(tx, context, t.journalEntryId, { memo: `Reverse payer transfer ${payerInv.number}` });
    await changeDoc(tx, context, payerInv, { status: 'Void' }, 'invoice.voided');
    const inv = await docOf(tx, context, t.patientInvoiceId, 'invoice');
    const paid = Math.max(0, round2(Number(inv.amountPaid) - Number(t.amount)));
    await changeDoc(tx, context, inv, { amountPaid: paid, status: statusFor(rates, inv, paid) }, 'invoice.payer_transfer_reversed');
    await tx.acctPayerTransfer.updateMany({ where: { ...org(context), id }, data: { reversedAt: new Date() } });
    await audited(tx, context, 'payer_transfer.reversed', 'payer_transfer', id);
    return { id };
  });
}

// ---- claims -----------------------------------------------------------------------------------------
async function claimOf(tx, context, id) {
  const c = await tx.acctPayerClaim.findFirst({ where: { ...org(context), id } });
  if (!c) throw notFound('Claim');
  return c;
}
/** The claim's lines: each of the payer's open invoices, at what it still owes, never on another open claim. */
async function claimItems(tx, context, payer, invoiceIds, { exceptClaimId } = {}) {
  const rates = await taxRates(tx, context);
  const invoices = await tx.acctSalesDoc.findMany({ where: { ...org(context), kind: 'invoice', id: { in: invoiceIds } } });
  if (invoices.length !== new Set(invoiceIds).size) throw new EmrError('VALIDATION_FAILED', { message: 'Some of those invoices were not found.' });
  const open = await tx.acctPayerClaim.findMany({ where: { ...org(context), status: { in: ['Draft', 'Submitted'] }, ...(exceptClaimId ? { id: { not: exceptClaimId } } : {}) }, select: { number: true, items: true } });
  const taken = new Map(open.flatMap((c) => c.items.map((i) => [i.invoiceId, c.number])));
  return invoices.map((inv) => {
    if (inv.customerId !== payer.id) throw new EmrError('VALIDATION_FAILED', { message: `${inv.number} is not ${payer.name}'s.` });
    if (!OPEN.includes(inv.status)) throw new EmrError('INVALID_STATE', { message: `${inv.number} is not open.` });
    if (taken.has(inv.id)) throw new EmrError('INVALID_STATE', { message: `${inv.number} is already on claim ${taken.get(inv.id)}.` });
    return { invoiceId: inv.id, number: inv.number, date: iso(inv.docDate), claimed: balanceOf(rates, inv) };
  });
}
export async function createClaim(context, { id, payerId, periodStart, periodEnd, invoiceIds, notes }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const payer = await payerOf(tx, context, payerId);
    const start = new Date(`${periodStart.slice(0, 10)}T00:00:00Z`); const end = new Date(`${periodEnd.slice(0, 10)}T23:59:59.999Z`);
    if (end < start) throw new EmrError('VALIDATION_FAILED', { message: 'The claim period must end on or after it starts.' });
    let ids = invoiceIds;
    if (!ids) {
      // by default: the payer's open invoices dated in the period that are on no open claim
      const open = await tx.acctPayerClaim.findMany({ where: { ...org(context), status: { in: ['Draft', 'Submitted'] } }, select: { items: true } });
      const taken = new Set(open.flatMap((c) => c.items.map((i) => i.invoiceId)));
      ids = (await tx.acctSalesDoc.findMany({ where: { ...org(context), kind: 'invoice', customerId: payer.id, status: { in: OPEN }, docDate: { gte: start, lte: end } }, orderBy: { docDate: 'asc' }, select: { id: true } })).map((i) => i.id).filter((i) => !taken.has(i));
    }
    if (!ids.length) throw new EmrError('VALIDATION_FAILED', { message: `${payer.name} has no open invoices in that period to claim.` });
    const items = await claimItems(tx, context, payer, ids);
    const number = await nextDocNumber(tx, context, 'payer-claim');
    const c = await tx.acctPayerClaim.create({ data: { ...(id ? { id } : {}), ...org(context), number, payerCustomerId: payer.id, periodStart: start, periodEnd: end, items, notes: notes ?? null, createdByUserId: context.userId } });
    await audited(tx, context, 'payer_claim.created', 'payer_claim', c.id);
    return { id: c.id, number, claimed: round2(items.reduce((n, i) => n + i.claimed, 0)) };
  });
}
export async function updateClaim(context, id, expectedVersion, { invoiceIds, notes }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const c = await claimOf(tx, context, id);
    if (c.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft claim can be changed.' });
    const data = { ...(notes !== undefined ? { notes } : {}) };
    if (invoiceIds) {
      if (!invoiceIds.length) throw new EmrError('VALIDATION_FAILED', { message: 'A claim needs at least one invoice; cancel it instead.' });
      data.items = await claimItems(tx, context, await payerOf(tx, context, c.payerCustomerId), invoiceIds, { exceptClaimId: id });
    }
    await updateVersioned(tx.acctPayerClaim, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'payer_claim.updated', 'payer_claim', id, Object.keys(data));
    return { id };
  });
}
export async function submitClaim(context, id, { reference }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const c = await claimOf(tx, context, id);
    if (c.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft claim can be submitted.' });
    await updateVersioned(tx.acctPayerClaim, { organizationId: context.organizationId, id, expectedVersion: c.version, data: { status: 'Submitted', reference: reference ?? null, submittedAt: new Date(), submittedByUserId: context.userId }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'payer_claim.submitted', 'payer_claim', id);
    return { id, status: 'Submitted' };
  });
}
export async function cancelClaim(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const c = await claimOf(tx, context, id);
    if (!['Draft', 'Submitted'].includes(c.status)) throw new EmrError('INVALID_STATE', { message: 'An adjudicated claim cannot be cancelled.' });
    await updateVersioned(tx.acctPayerClaim, { organizationId: context.organizationId, id, expectedVersion: c.version, data: { status: 'Cancelled', submittedAt: null }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'payer_claim.cancelled', 'payer_claim', id);
    return { id, status: 'Cancelled' };
  });
}
/** Records the payer's decision on each invoice; denials are written off or billed back to the patient. */
export async function adjudicateClaim(context, id, { items: decisions, date }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await ensureHealthAccounts(tx, context);
    const c = await claimOf(tx, context, id);
    if (c.status !== 'Submitted') throw new EmrError('INVALID_STATE', { message: 'Only a submitted claim can be adjudicated.' });
    const byInvoice = new Map(decisions.map((d) => [d.invoiceId, d]));
    if (byInvoice.size !== c.items.length || c.items.some((i) => !byInvoice.has(i.invoiceId))) throw new EmrError('VALIDATION_FAILED', { message: 'Record a decision for every invoice on the claim.' });
    const rates = await taxRates(tx, context);
    const payer = await customerOf(tx, context, c.payerCustomerId);
    const when = date ? new Date(date) : new Date();
    const items = [];
    for (const item of c.items) {
      const d = byInvoice.get(item.invoiceId);
      const approved = round2(d.approved);
      const denied = round2(item.claimed - approved);
      if (approved < 0 || denied < -0.005) throw new EmrError('VALIDATION_FAILED', { message: `${item.number}: approve between 0 and the ${item.claimed.toLocaleString('en-NG')} claimed.` });
      const out = { ...item, approved, denied: Math.max(0, denied), ...(d.reason ? { reason: d.reason } : {}) };
      if (denied > 0.005) {
        const inv = await docOf(tx, context, item.invoiceId, 'invoice');
        if (denied > balanceOf(rates, inv) + 0.01) throw new EmrError('INVALID_STATE', { message: `${inv.number} has been paid since it was claimed; less is left than the denial.` });
        const action = d.action ?? 'write-off';
        let lines;
        if (action === 'rebill') {
          const t = await tx.acctPayerTransfer.findFirst({ where: { ...org(context), payerInvoiceId: inv.id, reversedAt: null } });
          if (!t) throw new EmrError('VALIDATION_FAILED', { message: `${inv.number} was not billed from a patient's invoice; write the denial off instead.` });
          const patientInv = await docOf(tx, context, t.patientInvoiceId, 'invoice');
          const patient = await customerOf(tx, context, t.patientCustomerId);
          lines = [
            { accountNumber: patient.arAccountNumber, debit: denied, credit: 0, description: `Denied by ${payer.name} — billed back (${patientInv.number})`, customerId: patient.id },
            { accountNumber: payer.arAccountNumber, debit: 0, credit: denied, description: `Denied on ${c.number} — ${inv.number}`, customerId: payer.id },
          ];
          const reopened = Math.max(0, round2(Number(patientInv.amountPaid) - denied));
          await changeDoc(tx, context, patientInv, { amountPaid: reopened, status: statusFor(rates, patientInv, reopened) }, 'invoice.rebilled_after_denial');
          await tx.acctPayerTransfer.updateMany({ where: { ...org(context), id: t.id }, data: { rebilledAmount: round2(Number(t.rebilledAmount) + denied) } });
        } else {
          lines = [
            { accountNumber: ACCT.denials, debit: denied, credit: 0, description: `Denied on ${c.number} — ${inv.number}${d.reason ? `: ${d.reason}` : ''}`.slice(0, 300), customerId: payer.id },
            { accountNumber: payer.arAccountNumber, debit: 0, credit: denied, description: `Denied on ${c.number} — ${inv.number}`, customerId: payer.id },
          ];
        }
        const entry = await postEntry(tx, context, { date: when, source: 'Claim Adjudication', reference: c.number, memo: `${c.number} — ${inv.number} denied by ${payer.name}${action === 'rebill' ? ', billed to the patient' : ''}`, lines });
        const paid = round2(Number(inv.amountPaid) + denied);
        await changeDoc(tx, context, inv, { amountPaid: paid, status: statusFor(rates, inv, paid) }, 'invoice.claim_denied');
        Object.assign(out, { action, journalEntryId: entry.id });
      }
      items.push(out);
    }
    await updateVersioned(tx.acctPayerClaim, { organizationId: context.organizationId, id, expectedVersion: c.version, data: { status: 'Adjudicated', items, adjudicatedAt: new Date(), adjudicatedByUserId: context.userId }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'payer_claim.adjudicated', 'payer_claim', id);
    return { id, status: 'Adjudicated', approved: round2(items.reduce((n, i) => n + i.approved, 0)), denied: round2(items.reduce((n, i) => n + i.denied, 0)) };
  });
}

// ---- capitation -------------------------------------------------------------------------------------
export async function recordCapitation(context, { id, payerId, startPeriod, months, enrollees, ratePerEnrollee, receivedDate, depositAccountNumber, reference }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await ensureHealthAccounts(tx, context);
    const payer = await payerOf(tx, context, payerId);
    const deposit = await tx.acctAccount.findFirst({ where: { ...org(context), number: depositAccountNumber } });
    if (!deposit || !['cash', 'bank', 'current_asset'].includes(deposit.subtype)) throw new EmrError('VALIDATION_FAILED', { message: 'Deposit into a cash, bank or undeposited-funds account.' });
    const perMonth = round2(enrollees * ratePerEnrollee);
    const amount = round2(perMonth * months);
    const received = new Date(`${receivedDate.slice(0, 10)}T12:00:00Z`);
    const begun = (period) => monthStart(period).getTime() <= Math.max(received.getTime(), Date.UTC(received.getUTCFullYear(), received.getUTCMonth(), 1, 12));
    const entries = Array.from({ length: months }, (_, i) => { const period = addMonths(startPeriod, i); return { period, amount: perMonth, recognized: begun(period) }; });
    const now = entries.filter((e) => e.recognized).reduce((n, e) => n + e.amount, 0);
    const later = round2(amount - now);
    const number = await nextDocNumber(tx, context, 'capitation');
    const lines = [{ accountNumber: depositAccountNumber, debit: amount, credit: 0, description: `Capitation from ${payer.name} — ${enrollees} enrollees` }];
    if (now > 0) lines.push({ accountNumber: ACCT.capitation, debit: 0, credit: round2(now), description: `Capitation ${entries.filter((e) => e.recognized).map((e) => e.period).join(', ')}`, customerId: payer.id });
    if (later > 0) lines.push({ accountNumber: ACCT.deferred, debit: 0, credit: later, description: `Capitation received in advance — ${entries.filter((e) => !e.recognized).map((e) => e.period).join(', ')}`, customerId: payer.id });
    const entry = await postEntry(tx, context, { date: received, source: 'Capitation', reference: reference ?? number, memo: `${number} — capitation from ${payer.name}, ${startPeriod} for ${months} month(s)`, lines });
    const c = await tx.acctCapitation.create({
      data: {
        ...(id ? { id } : {}), ...org(context), number, payerCustomerId: payer.id, startPeriod, months, enrollees, ratePerEnrollee, amount, receivedDate: received, depositAccountNumber, reference: reference ?? null,
        entries: entries.map((e) => (e.recognized ? { ...e, journalEntryId: entry.id } : e)), journalEntryId: entry.id, createdByUserId: context.userId,
      },
    });
    await audited(tx, context, 'capitation.recorded', 'capitation', c.id);
    return { id: c.id, number, amount, recognized: round2(now), deferred: later };
  });
}
/** Recognizes every month of capitation that has begun by `asOf`. */
export async function recognizeCapitation(context, { asOf }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await ensureHealthAccounts(tx, context);
    const when = new Date(asOf);
    let recognized = 0; let total = 0;
    for (const c of await tx.acctCapitation.findMany({ where: org(context) })) {
      const due = c.entries.filter((e) => !e.recognized && monthStart(e.period).getTime() <= when.getTime());
      if (!due.length) continue;
      const entries = [...c.entries];
      for (const e of due) {
        const entry = await postEntry(tx, context, {
          date: new Date(Math.min(when.getTime(), Date.now(), Math.max(monthStart(e.period).getTime(), 0) + 27 * DAY)), source: 'Capitation', reference: c.number, memo: `${c.number} — capitation recognized for ${e.period}`,
          lines: [{ accountNumber: ACCT.deferred, debit: e.amount, credit: 0, description: `Release capitation ${e.period}`, customerId: c.payerCustomerId }, { accountNumber: ACCT.capitation, debit: 0, credit: e.amount, description: `Capitation ${e.period}`, customerId: c.payerCustomerId }],
        });
        entries[entries.findIndex((x) => x.period === e.period)] = { ...e, recognized: true, journalEntryId: entry.id };
        recognized += 1; total = round2(total + e.amount);
      }
      await updateVersioned(tx.acctCapitation, { organizationId: context.organizationId, id: c.id, expectedVersion: c.version, data: { entries }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    }
    if (recognized) await audited(tx, context, 'capitation.recognized', 'capitation', null, [String(recognized)]);
    return { months: recognized, amount: total };
  });
}

// ---- write-offs and recoveries ----------------------------------------------------------------------
export async function writeOffInvoice(context, invoiceId, { amount, reason, date }) {
  requireAcct(context, 'acct.approve');
  return withTenant(context, async (tx) => {
    await ensureHealthAccounts(tx, context);
    const rates = await taxRates(tx, context);
    const inv = await docOf(tx, context, invoiceId, 'invoice');
    if (!OPEN.includes(inv.status)) throw new EmrError('INVALID_STATE', { message: `${inv.number} is not open.` });
    const cust = await customerOf(tx, context, inv.customerId);
    const left = balanceOf(rates, inv);
    const amt = round2(amount ?? left);
    if (amt <= 0 || amt > left + 0.01) throw new EmrError('VALIDATION_FAILED', { message: `Write off at most the ${left.toLocaleString('en-NG')} left on ${inv.number}.` });
    const ngn = round2(amt * Number(inv.exchangeRate));
    const when = date ? new Date(date) : new Date();
    const fromAllowance = round2(Math.min(ngn, Math.max(0, await allowanceBalance(tx, context, when))));
    const lines = [];
    if (fromAllowance > 0) lines.push({ accountNumber: ACCT.allowance, debit: fromAllowance, credit: 0, description: `Write off ${inv.number} against the allowance`, customerId: cust.id });
    if (ngn - fromAllowance > 0.005) lines.push({ accountNumber: ACCT.badDebt, debit: round2(ngn - fromAllowance), credit: 0, description: `Write off ${inv.number}`, customerId: cust.id });
    lines.push({ accountNumber: cust.arAccountNumber, debit: 0, credit: ngn, description: `${inv.number} written off — ${reason}`.slice(0, 300), customerId: cust.id });
    const entry = await postEntry(tx, context, { date: when, source: 'Write-off', reference: inv.number, memo: `Bad debt written off — ${inv.number}, ${cust.name}`, lines });
    const paid = round2(Number(inv.amountPaid) + amt);
    await changeDoc(tx, context, inv, { amountPaid: paid, status: paid >= docTotal(rates, inv.lines) - 0.01 ? 'Written Off' : 'Partially Paid' }, 'invoice.written_off');
    const w = await tx.acctWriteOff.create({ data: { ...org(context), invoiceId: inv.id, customerId: cust.id, amount: ngn, fromAllowance, reason, journalEntryId: entry.id, createdByUserId: context.userId } });
    await audited(tx, context, 'invoice.write_off', 'invoice', inv.id, [String(ngn)]);
    return { id: w.id, amount: ngn, fromAllowance, toExpense: round2(ngn - fromAllowance) };
  });
}
export async function recoverWriteOff(context, id, { amount, date, depositAccountNumber, reference }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await ensureHealthAccounts(tx, context);
    const w = await tx.acctWriteOff.findFirst({ where: { ...org(context), id } });
    if (!w) throw notFound('Write-off');
    const left = round2(Number(w.amount) - Number(w.recoveredAmount));
    if (amount > left + 0.01) throw new EmrError('VALIDATION_FAILED', { message: `At most ${left.toLocaleString('en-NG')} of this write-off is left to recover.` });
    const deposit = await tx.acctAccount.findFirst({ where: { ...org(context), number: depositAccountNumber } });
    if (!deposit || !['cash', 'bank', 'current_asset'].includes(deposit.subtype)) throw new EmrError('VALIDATION_FAILED', { message: 'Deposit into a cash, bank or undeposited-funds account.' });
    const inv = await docOf(tx, context, w.invoiceId, 'invoice');
    const entry = await postEntry(tx, context, {
      date: date ? new Date(date) : new Date(), source: 'Recovery', reference: reference ?? inv.number, memo: `Recovered on written-off ${inv.number}`,
      lines: [{ accountNumber: depositAccountNumber, debit: amount, credit: 0, description: `Recovery — ${inv.number}` }, { accountNumber: ACCT.recovered, debit: 0, credit: amount, description: `Bad debt recovered — ${inv.number}`, customerId: w.customerId }],
    });
    await updateVersioned(tx.acctWriteOff, { organizationId: context.organizationId, id, expectedVersion: w.version, data: { recoveredAmount: round2(Number(w.recoveredAmount) + amount) }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'write_off.recovered', 'write_off', id, [String(amount)]);
    return { id, journalEntryId: entry.id };
  });
}

// ---- expected credit loss ---------------------------------------------------------------------------
/** The provision matrix applied to open invoices on `asOf`: balances and expected loss per band. */
async function measure(tx, context, asOf, rates) {
  const taxes = await taxRates(tx, context);
  const [invoices, customers] = await Promise.all([
    tx.acctSalesDoc.findMany({ where: { ...org(context), kind: 'invoice', status: { in: OPEN }, docDate: { lte: asOf } } }),
    tx.acctCustomer.findMany({ where: org(context), select: { id: true, type: true } }),
  ]);
  const typeOf = new Map(customers.map((c) => [c.id, c.type]));
  const buckets = ['patient', 'payer'].flatMap((group) => BANDS.map((band, i) => ({ group, band, balance: 0, rate: rates[group][i], expected: 0 })));
  for (const inv of invoices) {
    const group = PAYER_TYPES.includes(typeOf.get(inv.customerId)) ? 'payer' : 'patient';
    const late = inv.dueDate ? Math.floor((asOf.getTime() - inv.dueDate.getTime()) / DAY) : 0;
    const band = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4;
    const b = buckets.find((x) => x.group === group && x.band === BANDS[band]);
    b.balance = round2(b.balance + balanceOf(taxes, inv) * Number(inv.exchangeRate));
  }
  for (const b of buckets) b.expected = round2((b.balance * b.rate) / 100);
  return { buckets, required: round2(buckets.reduce((n, b) => n + b.expected, 0)) };
}
export async function creditLoss(context, { asOf, rates, post = false }) {
  requireAcct(context, post ? 'acct.approve' : 'acct.view');
  for (const g of ['patient', 'payer']) if (!Array.isArray(rates?.[g]) || rates[g].length !== BANDS.length || rates[g].some((r) => r < 0 || r > 100)) throw new EmrError('VALIDATION_FAILED', { message: 'Give five loss rates (0–100%) for patients and for payers.' });
  return withTenant(context, async (tx) => {
    await ensureHealthAccounts(tx, context);
    const when = asOf ? new Date(`${asOf.slice(0, 10)}T12:00:00Z`) : new Date();
    if (when.getTime() > Date.now() + DAY) throw new EmrError('VALIDATION_FAILED', { message: 'Measure the allowance as of today or an earlier date.' });
    const { buckets, required } = await measure(tx, context, when, rates);
    const previous = await allowanceBalance(tx, context, when);
    const adjustment = round2(required - previous);
    if (!post) return { asOf: when.toISOString().slice(0, 10), buckets, required, previous, adjustment };
    let entry = null;
    if (Math.abs(adjustment) >= 0.01) {
      entry = await postEntry(tx, context, {
        date: when, source: 'Credit Loss', reference: `ECL ${when.toISOString().slice(0, 10)}`, memo: `Expected credit loss — allowance ${adjustment > 0 ? 'increased' : 'released'} to ${required.toLocaleString('en-NG')}`,
        lines: adjustment > 0
          ? [{ accountNumber: ACCT.badDebt, debit: adjustment, credit: 0, description: 'Impairment of receivables (expected credit loss)' }, { accountNumber: ACCT.allowance, debit: 0, credit: adjustment, description: 'Allowance for doubtful debts' }]
          : [{ accountNumber: ACCT.allowance, debit: -adjustment, credit: 0, description: 'Allowance for doubtful debts released' }, { accountNumber: ACCT.badDebt, debit: 0, credit: -adjustment, description: 'Reversal of impairment of receivables' }],
      });
    }
    const run = await tx.acctCreditLossRun.create({ data: { ...org(context), asOf: when, rates, buckets, required, previous, adjustment: entry ? adjustment : 0, journalEntryId: entry?.id ?? null, createdByUserId: context.userId } });
    await audited(tx, context, 'credit_loss.measured', 'credit_loss_run', run.id, [String(required)]);
    return { id: run.id, asOf: when.toISOString().slice(0, 10), buckets, required, previous, adjustment: entry ? adjustment : 0, journalEntryId: entry?.id };
  });
}
