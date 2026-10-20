// Cost centres, budgets and tax returns.
//
// Rules enforced here:
//   - a cost-centre code is unique; centres are switched off, never deleted;
//   - a budget holds twelve monthly amounts per ledger account (and cost centre); only a draft is edited;
//     activating one closes the year's previous active budget, and activating takes approval rights;
//   - a tax return is prepared from the period's movement on its liability account (credits accrue output
//     tax, debits are reclaims — for VAT); one return per type and period;
//   - filing is recorded with the acknowledgement the authority's portal issued (there is no direct
//     e-filing link); remitting posts Dr the liability, Cr the paying bank or cash account;
//   - acct.view reads; acct.post prepares, files and remits.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { ensureBooks, postEntry, requireAcct, round2, totalsByAccount } from '../ledger/ledger.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
const iso = (d) => (d ? d.toISOString() : undefined);
const rid = () => Math.random().toString(36).slice(2, 10);
const RETURNS = {
  VAT: { kind: 'VAT', authority: 'FIRS', account: 2200, hasInput: true },
  WHT: { kind: 'WHT', authority: 'FIRS', account: 2210, hasInput: false },
  PAYE: { kind: 'VAT', authority: 'State IRS', account: 2300, hasInput: false },
};
const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const [centres, budgets, returns] = await Promise.all([
      tx.acctCostCentre.findMany({ where: org(context), orderBy: { code: 'asc' } }),
      tx.acctBudget.findMany({ where: org(context), orderBy: [{ fiscalYear: 'desc' }, { createdAt: 'desc' }] }),
      tx.acctTaxReturn.findMany({ where: org(context), orderBy: { periodEnd: 'desc' } }),
    ]);
    const names = await userNameMap(tx, returns.map((r) => r.filedByUserId));
    return {
      costCentres: centres.map((c) => ({ id: c.id, code: c.code, name: c.name, active: c.active, version: c.version })),
      budgets: budgets.map((b) => ({ id: b.id, name: b.name, fiscalYear: b.fiscalYear, status: b.status, lines: b.lines, createdAt: iso(b.createdAt), version: b.version })),
      taxReturns: returns.map((r) => {
        const cfg = RETURNS[r.returnType];
        return {
          id: r.id, reference: r.reference, kind: cfg.kind, returnType: r.returnType, authority: r.authority, liabilityAccount: r.liabilityAccount, periodStart: iso(r.periodStart), periodEnd: iso(r.periodEnd),
          outputTax: Number(r.outputTax), inputTax: Number(r.inputTax), netPayable: Number(r.netPayable), status: r.status, submissionRef: r.submissionRef ?? undefined, filedVia: r.filedVia ?? undefined,
          filedAt: iso(r.filedAt), filedBy: r.filedByUserId ? names.get(r.filedByUserId) ?? 'Former member' : undefined, paidAt: iso(r.paidAt), journalEntryId: r.journalEntryId ?? undefined, version: r.version,
        };
      }),
    };
  });
}

// ---- cost centres -----------------------------------------------------------------------------------
export async function addCostCentre(context, { id, code, name }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    try {
      const c = await tx.acctCostCentre.create({ data: { ...(id ? { id } : {}), ...org(context), code: code.toUpperCase(), name } });
      await audited(tx, context, 'cost_centre.added', 'cost_centre', c.id);
      return { id: c.id };
    } catch (error) { throw uniqueViolation(error, { code_key: 'HR_CODE_IN_USE', pkey: 'HR_CODE_IN_USE' }) ?? error; }
  });
}
export async function updateCostCentre(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.acctCostCentre, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'cost_centre.updated', 'cost_centre', id, Object.keys(data));
    return { id };
  });
}

// ---- budgets ----------------------------------------------------------------------------------------
async function budgetOf(tx, context, id) {
  const b = await tx.acctBudget.findFirst({ where: { ...org(context), id } });
  if (!b) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Budget not found.' });
  return b;
}
async function checkLine(tx, context, line) {
  const a = await tx.acctAccount.findFirst({ where: { ...org(context), number: line.accountNumber } });
  if (!a || !a.isActive) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${line.accountNumber} is not available.` });
  if (line.costCentreId && !(await tx.acctCostCentre.findFirst({ where: { ...org(context), id: line.costCentreId } }))) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Cost centre not found.' });
}
export async function createBudget(context, { id, name, fiscalYear, copyFromId, adjustPct }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const factor = 1 + (adjustPct ?? 0) / 100;
    const lines = copyFromId ? (await budgetOf(tx, context, copyFromId)).lines.map((l) => ({ ...l, id: `bl-${rid()}`, monthly: l.monthly.map((v) => Math.round(v * factor)) })) : [];
    const b = await tx.acctBudget.create({ data: { ...(id ? { id } : {}), ...org(context), name, fiscalYear, lines, createdByUserId: context.userId } });
    await audited(tx, context, 'budget.created', 'budget', b.id, copyFromId ? ['copied'] : []);
    return { id: b.id };
  });
}
export async function setBudgetStatus(context, id, { status }) {
  requireAcct(context, status === 'Active' ? 'acct.approve' : 'acct.post');
  return withTenant(context, async (tx) => {
    const b = await budgetOf(tx, context, id);
    if (b.status === status) return { id, status };
    // only one active budget per fiscal year: the previous one closes
    if (status === 'Active') await tx.acctBudget.updateMany({ where: { ...org(context), fiscalYear: b.fiscalYear, status: 'Active', NOT: { id } }, data: { status: 'Closed', version: { increment: 1 } } });
    await updateVersioned(tx.acctBudget, { organizationId: context.organizationId, id, expectedVersion: b.version, data: { status }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, `budget.${status.toLowerCase()}`, 'budget', id);
    return { id, status };
  });
}
async function editLines(context, id, edit, action) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const b = await budgetOf(tx, context, id);
    if (b.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft budget can be changed. Return it to draft first.' });
    const lines = await edit(tx, b.lines);
    await updateVersioned(tx.acctBudget, { organizationId: context.organizationId, id, expectedVersion: b.version, data: { lines }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, action, 'budget', id);
    return { id };
  });
}
export const upsertLine = (context, id, line) => editLines(context, id, async (tx, lines) => {
  await checkLine(tx, context, line);
  const clean = { accountNumber: line.accountNumber, ...(line.costCentreId ? { costCentreId: line.costCentreId } : {}), monthly: line.monthly.map(round2) };
  return line.id && lines.some((l) => l.id === line.id) ? lines.map((l) => (l.id === line.id ? { id: l.id, ...clean } : l)) : [...lines, { id: line.id ?? `bl-${rid()}`, ...clean }];
}, 'budget.line_saved');
export const removeLine = (context, id, lineId) => editLines(context, id, async (tx, lines) => lines.filter((l) => l.id !== lineId), 'budget.line_removed');

// ---- tax returns ------------------------------------------------------------------------------------
export async function prepareReturn(context, { id, returnType, periodStart, periodEnd }) {
  requireAcct(context, 'acct.post');
  const cfg = RETURNS[returnType];
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (end < start) throw new EmrError('VALIDATION_FAILED', { message: 'The period ends before it starts.' });
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const reference = `${returnType}-${ym(end)}`;
    if (await tx.acctTaxReturn.findFirst({ where: { ...org(context), reference } })) throw new EmrError('INVALID_STATE', { message: `A ${returnType} return for ${ym(end)} has already been prepared.` });
    const dc = (await totalsByAccount(tx, context, { from: start, asOf: end })).get(cfg.account) ?? { debit: 0, credit: 0 };
    // Remittances of earlier returns are debits too; leave them out of the reclaim.
    const remitted = await tx.acctTaxReturn.findMany({ where: { ...org(context), liabilityAccount: cfg.account, paidAt: { gte: start, lte: end } }, select: { netPayable: true } });
    const output = round2(dc.credit);
    const input = cfg.hasInput ? Math.max(0, round2(dc.debit - remitted.reduce((s, r) => s + Number(r.netPayable), 0))) : 0;
    const r = await tx.acctTaxReturn.create({
      data: { ...(id ? { id } : {}), ...org(context), reference, returnType, authority: cfg.authority, liabilityAccount: cfg.account, periodStart: start, periodEnd: end, outputTax: output, inputTax: input, netPayable: round2(output - input), preparedByUserId: context.userId },
    });
    await audited(tx, context, 'tax_return.prepared', 'tax_return', r.id);
    return { id: r.id, reference, netPayable: round2(output - input) };
  });
}
async function returnOf(tx, context, id) {
  const r = await tx.acctTaxReturn.findFirst({ where: { ...org(context), id } });
  if (!r) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Tax return not found.' });
  return r;
}
/** Records a filing made on the authority's portal, with the acknowledgement it issued. */
export async function recordFiling(context, id, { submissionRef, filedVia }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const r = await returnOf(tx, context, id);
    if (r.status !== 'Open') throw new EmrError('INVALID_STATE', { message: 'This return has already been filed.' });
    await updateVersioned(tx.acctTaxReturn, {
      organizationId: context.organizationId, id, expectedVersion: r.version, notFoundCode: 'HR_RECORD_NOT_FOUND',
      data: { status: 'Filed', submissionRef, filedVia: filedVia ?? `${r.authority} e-filing portal`, filedAt: new Date(), filedByUserId: context.userId },
    });
    await audited(tx, context, 'tax_return.filed', 'tax_return', id);
    return { id, status: 'Filed' };
  });
}
export async function payReturn(context, id, { fromAccount }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const r = await returnOf(tx, context, id);
    if (r.status === 'Paid') throw new EmrError('INVALID_STATE', { message: 'This return has already been paid.' });
    const amount = Number(r.netPayable);
    if (amount <= 0) throw new EmrError('INVALID_STATE', { message: 'Nothing is payable on this return.' });
    const bank = await tx.acctAccount.findFirst({ where: { ...org(context), number: fromAccount } });
    if (!bank || !['bank', 'cash'].includes(bank.subtype) || !bank.isActive) throw new EmrError('VALIDATION_FAILED', { message: `Account ${fromAccount} is not an available bank or cash account.` });
    const entry = await postEntry(tx, context, {
      date: new Date(), source: 'Tax', memo: `${r.returnType} remittance — ${r.reference}`, reference: r.reference,
      lines: [{ accountNumber: r.liabilityAccount, debit: amount, credit: 0, description: `${r.returnType} settled with ${r.authority}` }, { accountNumber: fromAccount, debit: 0, credit: amount, description: `Payment to ${r.authority}` }],
    });
    await updateVersioned(tx.acctTaxReturn, { organizationId: context.organizationId, id, expectedVersion: r.version, data: { status: 'Paid', paidAt: new Date(), journalEntryId: entry.id }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'tax_return.paid', 'tax_return', id);
    return { id, status: 'Paid' };
  });
}
