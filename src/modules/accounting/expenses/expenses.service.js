// Expense claims: staff and petty-cash spending that is not a vendor bill.
//
// Rules enforced here:
//   - a claim's lines go to active expense (or cost-of-sales) accounts; the claimant is one of the
//     organization's staff (yourself by default);
//   - submitting builds an approval from the organization's rules ("Expense Claim", by amount) — never
//     decided by whoever submitted it — and the claim posts only once approved (or at once, when no rule
//     covers its amount): Dr each line and the recoverable input tax, Cr petty cash, the paying bank, or
//     Reimbursements Payable for a claim to be reimbursed;
//   - a reimbursement settles the payable from a bank or cash account;
//   - acct.view reads; acct.post prepares, submits and pays.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { postEntry, requireAcct, round2 } from '../ledger/ledger.service.js';
import { nextDocNumber, taxBreakdown, taxRates } from '../settings/settings.service.js';
import { NOT_REQUIRED, approvalUserIds, buildApproval, decideApproval, presentApproval } from '../control/approvals.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const audited = (tx, context, action, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType: 'expense_claim', resourceId, changedFields });
const ACCT = { cashOnHand: 1000, reimbursementsPayable: 2110 };
const REIMBURSE = 'Reimburse to staff';
const rid = () => Math.random().toString(36).slice(2, 10);
const iso = (d) => (d ? d.toISOString() : undefined);

const subtotal = (lines) => round2(lines.reduce((n, l) => n + l.amount, 0));
const taxLines = (rates, lines) => lines.flatMap((l) => (l.taxRateId ? taxBreakdown(rates, l.amount, [l.taxRateId]) : []));
const claimTotal = (rates, lines) => round2(subtotal(lines) + taxLines(rates, lines).reduce((n, b) => n + b.amount, 0));

async function claimOf(tx, context, id) {
  const c = await tx.acctExpenseClaim.findFirst({ where: { ...org(context), id } });
  if (!c || c.status === 'Discarded') throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Expense claim not found.' });
  return c;
}
async function cashAccount(tx, context, number) {
  const a = await tx.acctAccount.findFirst({ where: { ...org(context), number } });
  if (!a || !['bank', 'cash'].includes(a.subtype) || !a.isActive) throw new EmrError('VALIDATION_FAILED', { message: `Account ${number} is not an available bank or cash account.` });
  return a;
}
async function cleanLines(tx, context, lines, rates) {
  const kept = lines.filter((l) => l.amount > 0);
  if (!kept.length) throw new EmrError('VALIDATION_FAILED', { message: 'Add at least one line with an amount.' });
  const accounts = new Map((await tx.acctAccount.findMany({ where: { ...org(context), number: { in: [...new Set(kept.map((l) => l.accountNumber))] } } })).map((a) => [a.number, a]));
  return kept.map((l) => {
    const a = accounts.get(l.accountNumber);
    if (!a || !a.isActive || !['expense', 'cogs'].includes(a.type)) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${l.accountNumber} is not an available expense account.` });
    if (l.taxRateId && !rates.has(l.taxRateId)) throw new EmrError('VALIDATION_FAILED', { message: `Unknown tax rate ${l.taxRateId}.` });
    return { id: l.id ?? `el-${rid()}`, accountNumber: l.accountNumber, description: l.description, amount: round2(l.amount), ...(l.taxRateId ? { taxRateId: l.taxRateId } : {}) };
  });
}
// A reimbursement is owed to a member of staff: without an HR record there is nobody to pay.
const noClaimant = () => new EmrError('VALIDATION_FAILED', { message: 'A claim reimbursed to staff needs the claimant’s staff record. You have none in HR yet: ask HR to add you, or choose petty cash or a direct bank payment.' });
async function claimant(tx, context, employeeId) {
  if (!employeeId) return (await tx.wfEmployee.findFirst({ where: { ...org(context), userId: context.userId }, select: { id: true, name: true } })) ?? null;
  const e = await tx.wfEmployee.findFirst({ where: { ...org(context), id: employeeId }, select: { id: true, name: true } });
  if (!e) throw new EmrError('EMPLOYEE_NOT_FOUND');
  return e;
}
async function checkPayMode(tx, context, payMode, paidFromAccount) {
  if (payMode === 'Bank — direct') {
    if (!paidFromAccount) throw new EmrError('VALIDATION_FAILED', { message: 'Pick the bank account it was paid from.' });
    await cashAccount(tx, context, paidFromAccount);
  }
}

/** The accrual: Dr each line (and input tax), Cr where the money came from or the reimbursement owed. */
async function postAccrual(tx, context, c) {
  const rates = await taxRates(tx, context);
  const who = (await claimant(tx, context, c.claimantEmployeeId))?.name ?? 'Staff';
  const credit = c.payMode === REIMBURSE ? ACCT.reimbursementsPayable : c.payMode === 'Petty Cash' ? ACCT.cashOnHand : c.paidFromAccount;
  const lines = c.lines.map((l) => ({ accountNumber: l.accountNumber, debit: l.amount, credit: 0, description: l.description, costCenter: c.costCenter ?? undefined }));
  for (const b of taxLines(rates, c.lines)) if (b.amount > 0) lines.push({ accountNumber: b.accountNumber, debit: b.amount, credit: 0, description: `Input ${b.label} — ${c.number}` });
  lines.push({ accountNumber: credit, debit: 0, credit: claimTotal(rates, c.lines), description: `${c.number} — ${who}` });
  return postEntry(tx, context, { date: c.claimDate, source: 'Expense', memo: `Expense claim ${c.number} — ${c.title}`, reference: c.number, lines });
}
async function book(tx, context, c, approval, action) {
  const entry = await postAccrual(tx, context, c);
  const settled = c.payMode !== REIMBURSE;
  await updateVersioned(tx.acctExpenseClaim, {
    organizationId: context.organizationId, id: c.id, expectedVersion: c.version, notFoundCode: 'HR_RECORD_NOT_FOUND',
    data: { approval, status: settled ? 'Paid' : 'Approved', journalEntryId: entry.id, ...(settled ? { paidAt: new Date() } : {}) },
  });
  await audited(tx, context, action, c.id);
  return settled ? 'Paid' : 'Approved';
}

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    const claims = await tx.acctExpenseClaim.findMany({ where: { ...org(context), status: { not: 'Discarded' } }, orderBy: [{ claimDate: 'desc' }, { createdAt: 'desc' }] });
    const names = await userNameMap(tx, claims.flatMap((c) => [c.createdByUserId, ...approvalUserIds(c.approval)]));
    return {
      claims: claims.map((c) => ({
        id: c.id, number: c.number, claimantId: c.claimantEmployeeId ?? undefined, date: iso(c.claimDate), title: c.title, costCenter: c.costCenter ?? undefined, payMode: c.payMode,
        paidFromAccount: c.paidFromAccount ?? undefined, lines: c.lines, receiptRef: c.receiptRef ?? undefined, status: c.status, approval: presentApproval(context, c.approval, names),
        journalEntryId: c.journalEntryId ?? undefined, paymentJournalEntryId: c.paymentJournalEntryId ?? undefined, createdBy: names.get(c.createdByUserId) ?? 'Former member',
        createdAt: iso(c.createdAt), paidAt: iso(c.paidAt), version: c.version,
      })),
    };
  });
}

// ---- preparing --------------------------------------------------------------------------------------
export async function createClaim(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const lines = await cleanLines(tx, context, input.lines, await taxRates(tx, context));
    const who = await claimant(tx, context, input.claimantId);
    if (input.payMode === REIMBURSE && !who) throw noClaimant();
    await checkPayMode(tx, context, input.payMode, input.paidFromAccount);
    const number = await nextDocNumber(tx, context, 'expense');
    try {
      const c = await tx.acctExpenseClaim.create({
        data: {
          ...(input.id ? { id: input.id } : {}), ...org(context), number, claimantEmployeeId: who?.id ?? null, claimDate: new Date(input.date), title: input.title, costCenter: input.costCenter ?? null,
          payMode: input.payMode, paidFromAccount: input.payMode === 'Bank — direct' ? input.paidFromAccount : null, lines, receiptRef: input.receiptRef ?? null, approval: NOT_REQUIRED, createdByUserId: context.userId,
        },
      });
      await audited(tx, context, 'expense_claim.created', c.id);
      return { id: c.id, number };
    } catch (error) { throw uniqueViolation(error, { pkey: 'HR_CODE_IN_USE', number_key: 'HR_CODE_IN_USE' }) ?? error; }
  });
}
export async function updateClaim(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const c = await claimOf(tx, context, id);
    if (c.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft claim can be edited.' });
    const payMode = patch.payMode ?? c.payMode;
    if (payMode === REIMBURSE && !c.claimantEmployeeId) throw noClaimant();
    const paidFrom = patch.paidFromAccount ?? c.paidFromAccount;
    await checkPayMode(tx, context, payMode, paidFrom);
    const data = Object.fromEntries(Object.entries({
      claimDate: patch.date ? new Date(patch.date) : undefined, title: patch.title, costCenter: patch.costCenter, payMode: patch.payMode, receiptRef: patch.receiptRef,
      paidFromAccount: payMode === 'Bank — direct' ? paidFrom : null, lines: patch.lines ? await cleanLines(tx, context, patch.lines, await taxRates(tx, context)) : undefined,
    }).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.acctExpenseClaim, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'expense_claim.updated', id, Object.keys(data));
    return { id };
  });
}
export async function discardDraft(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const c = await claimOf(tx, context, id);
    if (c.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft claim can be discarded.' });
    await updateVersioned(tx.acctExpenseClaim, { organizationId: context.organizationId, id, expectedVersion: c.version, data: { status: 'Discarded' }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'expense_claim.discarded', id);
    return { id };
  });
}

// ---- approval and payment ---------------------------------------------------------------------------
export async function submitClaim(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const c = await claimOf(tx, context, id);
    if (c.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'This claim has already been submitted.' });
    const approval = await buildApproval(tx, context, 'Expense Claim', claimTotal(await taxRates(tx, context), c.lines));
    if (approval.status === 'Not Required') return { id, status: await book(tx, context, c, approval, 'expense_claim.booked') };
    await updateVersioned(tx.acctExpenseClaim, { organizationId: context.organizationId, id, expectedVersion: c.version, data: { approval, status: 'Pending Approval' }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'expense_claim.submitted', id);
    return { id, status: 'Pending Approval' };
  });
}
export async function decideClaim(context, id, { decision, comment }) {
  return withTenant(context, async (tx) => {
    const c = await claimOf(tx, context, id);
    if (c.status !== 'Pending Approval') throw new EmrError('INVALID_STATE', { message: 'This claim is not waiting for approval.' });
    const approval = decideApproval(context, c.approval, decision, comment);
    if (approval.status === 'Approved') return { id, status: await book(tx, context, c, approval, 'expense_claim.approved') };
    const status = approval.status === 'Rejected' ? 'Rejected' : c.status;
    await updateVersioned(tx.acctExpenseClaim, { organizationId: context.organizationId, id, expectedVersion: c.version, data: { approval, status }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, `expense_claim.${decision.toLowerCase()}`, id);
    return { id, status };
  });
}
export async function payClaim(context, id, { fromAccount }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const c = await claimOf(tx, context, id);
    if (c.status !== 'Approved' || c.payMode !== REIMBURSE) throw new EmrError('INVALID_STATE', { message: 'Nothing to reimburse.' });
    const bank = await cashAccount(tx, context, fromAccount);
    const amount = claimTotal(await taxRates(tx, context), c.lines);
    const who = (await claimant(tx, context, c.claimantEmployeeId))?.name ?? 'Staff';
    const entry = await postEntry(tx, context, {
      date: new Date(), source: 'Expense', memo: `Reimbursement of ${c.number} — ${who}`, reference: c.number,
      lines: [{ accountNumber: ACCT.reimbursementsPayable, debit: amount, credit: 0, description: `Settle ${c.number}` }, { accountNumber: bank.number, debit: 0, credit: amount, description: `Paid to ${who}` }],
    });
    await updateVersioned(tx.acctExpenseClaim, { organizationId: context.organizationId, id, expectedVersion: c.version, data: { status: 'Paid', paymentJournalEntryId: entry.id, paidFromAccount: bank.number, paidAt: new Date() }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'expense_claim.paid', id);
    return { id, status: 'Paid' };
  });
}
