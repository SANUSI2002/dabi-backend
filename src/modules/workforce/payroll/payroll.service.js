// Payroll records: salary structures, payslip batches, contracts, staff loans and reimbursements.
//
// Rules enforced here:
//   - salary data needs payroll.read; every change needs payroll.manage;
//   - a payslip is computed by the server from the employee's salary structure (plus the instalment
//     of a salary-auto-debit loan); it moves Draft → Review Ongoing → Confirmed → Paid, and whoever
//     generated the batch does not confirm it (maker-checker);
//   - "Paid" records that the salary was paid outside Sabi (bank transfer, etc.) — nothing here moves
//     money. A loan instalment taken from salary is recorded as a repayment when that payslip is paid;
//   - nobody decides their own loan or reimbursement, or one they requested;
//   - a loan above the eligibility tier for the employee's salary is refused;
//   - an overdue letter is a printable record; "sent" records that HR sent it — no mail is sent.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';

const org = (context) => ({ organizationId: context.organizationId });
const money = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => (v === null || v === undefined ? undefined : Number(v));
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : undefined);
const toDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00.000Z`) : null);
const notFound = () => new EmrError('HR_RECORD_NOT_FOUND');
const sum = (list) => money(list.reduce((n, c) => n + Number(c.amount), 0));
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
const PERIOD_DAYS = 30;
const NEXT = { Draft: 'Review Ongoing', 'Review Ongoing': 'Confirmed', Confirmed: 'Paid' };

async function employee(tx, context, id, { active = false } = {}) {
  const e = await tx.wfEmployee.findFirst({ where: { ...org(context), id }, select: { id: true, name: true, status: true, userId: true } });
  if (!e) throw new EmrError('EMPLOYEE_NOT_FOUND');
  if (active && e.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: `${e.name} is not an active employee.` });
  return e;
}
/** Nobody decides a request about themselves, or one they raised. */
async function requireOtherDecider(tx, context, row) {
  const subject = await employee(tx, context, row.employeeId);
  if (subject.userId === context.userId || row.requestedByUserId === context.userId) throw new EmrError('OWN_REQUEST');
}

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  return withTenant(context, async (tx) => {
    const [structures, payslips, contracts, loans, payments, letters, tiers, reimbursements] = await Promise.all([
      tx.wfSalaryStructure.findMany({ where: org(context) }),
      tx.wfPayslip.findMany({ where: org(context), orderBy: [{ startDate: 'desc' }, { generatedAt: 'desc' }] }),
      tx.wfContract.findMany({ where: org(context), orderBy: { startDate: 'desc' } }),
      tx.wfLoan.findMany({ where: org(context), orderBy: { requestedAt: 'desc' } }),
      tx.wfLoanPayment.findMany({ where: org(context), orderBy: { paidOn: 'desc' } }),
      tx.wfLoanLetter.findMany({ where: org(context), orderBy: { issuedAt: 'desc' } }),
      tx.wfLoanTier.findMany({ where: org(context), orderBy: { minMonthlySalary: 'asc' } }),
      tx.wfReimbursement.findMany({ where: org(context), orderBy: { requestedAt: 'desc' } }),
    ]);
    return {
      salaryStructures: structures.map((s) => ({ id: s.id, employeeId: s.employeeId, basicSalary: Number(s.basicSalary), allowances: s.allowances, deductions: s.deductions, effectiveFrom: s.effectiveFrom, version: s.version })),
      payslips: payslips.map((p) => ({
        id: p.id, employeeId: p.employeeId, batch: p.batch, startDate: isoDay(p.startDate), endDate: isoDay(p.endDate), basicSalary: Number(p.basicSalary), allowances: p.allowances,
        deductions: p.deductions, grossPay: Number(p.grossPay), totalDeductions: Number(p.totalDeductions), netPay: Number(p.netPay), status: p.status,
        generatedByMe: p.generatedByUserId === context.userId, confirmedAt: p.confirmedAt ?? undefined, paidAt: p.paidAt ?? undefined,
      })),
      contracts: contracts.map((c) => ({ id: c.id, employeeId: c.employeeId, title: c.title, startDate: isoDay(c.startDate), endDate: isoDay(c.endDate), basicSalary: Number(c.basicSalary), status: c.status })),
      loans: loans.map((l) => ({
        id: l.id, employeeId: l.employeeId, type: l.type, amount: Number(l.amount), installments: l.installments, installmentAmount: Number(l.installmentAmount), installmentsPaid: l.installmentsPaid,
        requestedDate: l.requestedAt, status: l.status, reason: l.reason, repaymentMethod: l.repaymentMethod, currentPeriodDue: Number(l.currentPeriodDue), currentPeriodPaid: Number(l.currentPeriodPaid),
        periodStartDate: l.periodStartDate ?? undefined, missedPeriods: l.missedPeriods, totalPaid: Number(l.totalPaid),
      })),
      loanPayments: payments.map((p) => ({ id: p.id, loanId: p.loanId, amount: Number(p.amount), date: isoDay(p.paidOn) })),
      escalationLetters: letters.map((x) => ({ id: x.id, loanId: x.loanId, level: x.level, issuedDate: x.issuedAt, amountOwed: Number(x.amountOwed), sent: x.sent, sentAt: x.sentAt ?? undefined })),
      loanEligibilityTiers: tiers.map((t) => ({ id: t.id, minMonthlySalary: Number(t.minMonthlySalary), maxMonthlySalary: t.maxMonthlySalary === null ? null : Number(t.maxMonthlySalary), maxLoanAmount: Number(t.maxLoanAmount) })),
      reimbursements: reimbursements.map((r) => ({ id: r.id, employeeId: r.employeeId, type: r.type, title: r.title, amount: Number(r.amount), requestedDate: r.requestedAt, status: r.status })),
    };
  });
}

// ---- salary and payslips ----------------------------------------------------------------------------
export async function setStructure(context, employeeId, { basicSalary, allowances, deductions }) {
  return withTenant(context, async (tx) => {
    await employee(tx, context, employeeId);
    const data = { basicSalary: money(basicSalary), allowances: allowances.map((a) => ({ name: a.name, amount: money(a.amount) })), deductions: deductions.map((d) => ({ name: d.name, amount: money(d.amount) })), effectiveFrom: new Date(), updatedByUserId: context.userId };
    const existing = await tx.wfSalaryStructure.findFirst({ where: { ...org(context), employeeId } });
    if (existing) await tx.wfSalaryStructure.updateMany({ where: { ...org(context), id: existing.id }, data: { ...data, version: { increment: 1 } } });
    else await tx.wfSalaryStructure.create({ data: { ...org(context), employeeId, ...data } });
    await audited(tx, context, 'payroll.structure_set', 'employee', employeeId);
    return { employeeId };
  });
}
export async function runBatch(context, { batch, startDate, endDate, employeeIds }) {
  if (endDate < startDate) throw new EmrError('VALIDATION_FAILED', { message: 'The pay period ends before it starts.' });
  return withTenant(context, async (tx) => {
    const ids = [...new Set(employeeIds)];
    const [employees, structures, loans] = await Promise.all([
      tx.wfEmployee.findMany({ where: { ...org(context), id: { in: ids } }, select: { id: true, name: true, status: true } }),
      tx.wfSalaryStructure.findMany({ where: { ...org(context), employeeId: { in: ids } } }),
      tx.wfLoan.findMany({ where: { ...org(context), employeeId: { in: ids }, status: { in: ['Repaying', 'Overdue'] }, repaymentMethod: 'Salary Auto-Debit' } }),
    ]);
    if (employees.length !== ids.length) throw new EmrError('EMPLOYEE_NOT_FOUND');
    const missing = employees.filter((e) => !structures.some((s) => s.employeeId === e.id)).map((e) => e.name);
    if (missing.length) throw new EmrError('VALIDATION_FAILED', { message: `Set a salary for ${missing.join(', ')} first.` });
    const rows = ids.map((employeeId) => {
      const s = structures.find((x) => x.employeeId === employeeId);
      const loan = loans.find((l) => l.employeeId === employeeId);
      const deductions = [...s.deductions, ...(loan ? [{ name: 'Loan repayment (auto-debit)', amount: money(Number(loan.currentPeriodDue) - Number(loan.currentPeriodPaid)) }] : [])];
      const gross = money(Number(s.basicSalary) + sum(s.allowances));
      const totalDeductions = sum(deductions);
      return {
        ...org(context), employeeId, batch, startDate: toDate(startDate), endDate: toDate(endDate), basicSalary: s.basicSalary, allowances: s.allowances, deductions,
        grossPay: gross, totalDeductions, netPay: money(gross - totalDeductions), loanId: loan?.id ?? null, loanDeduction: loan ? deductions.at(-1).amount : null, generatedByUserId: context.userId,
      };
    });
    try {
      await tx.wfPayslip.createMany({ data: rows });
    } catch (error) { throw uniqueViolation(error, { batch_employee: 'PAYSLIP_EXISTS' }) ?? error; }
    await audited(tx, context, 'payroll.batch_generated', 'payroll_batch', null, [batch, String(rows.length)]);
    return { batch, payslips: rows.length };
  });
}
async function recordLoanPayment(tx, context, loan, amount, paidOn, payslipId = null) {
  await tx.wfLoanPayment.create({ data: { ...org(context), loanId: loan.id, amount: money(amount), paidOn, payslipId, recordedByUserId: context.userId } });
  const paidThisPeriod = money(Number(loan.currentPeriodPaid) + amount);
  const totalPaid = money(Number(loan.totalPaid) + amount);
  let data;
  if (paidThisPeriod >= Number(loan.currentPeriodDue)) {
    const installmentsPaid = Math.min(loan.installments, loan.installmentsPaid + 1);
    const settled = installmentsPaid >= loan.installments;
    data = { installmentsPaid, totalPaid, status: settled ? 'Settled' : 'Repaying', currentPeriodDue: settled ? 0 : loan.installmentAmount, currentPeriodPaid: 0, ...(settled ? {} : { periodStartDate: paidOn }) };
  } else {
    data = { currentPeriodPaid: paidThisPeriod, totalPaid };
  }
  await updateVersioned(tx.wfLoan, { organizationId: context.organizationId, id: loan.id, expectedVersion: loan.version, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
}
async function advanceOne(tx, context, p) {
  const next = NEXT[p.status];
  if (!next) throw new EmrError('INVALID_STATE', { message: 'This payslip has been paid.' });
  if (next === 'Confirmed' && p.generatedByUserId === context.userId) throw new EmrError('MAKER_CHECKER');
  const now = new Date();
  const data = { status: next, ...(next === 'Confirmed' ? { confirmedByUserId: context.userId, confirmedAt: now } : {}), ...(next === 'Paid' ? { paidByUserId: context.userId, paidAt: now } : {}) };
  await updateVersioned(tx.wfPayslip, { organizationId: context.organizationId, id: p.id, expectedVersion: p.version, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
  if (next === 'Paid' && p.loanId && Number(p.loanDeduction) > 0) {
    const loan = await tx.wfLoan.findFirst({ where: { ...org(context), id: p.loanId } });
    if (loan && ['Repaying', 'Overdue'].includes(loan.status)) await recordLoanPayment(tx, context, loan, Number(p.loanDeduction), p.endDate, p.id);
  }
  return next;
}
export async function advancePayslip(context, id) {
  return withTenant(context, async (tx) => {
    const p = await tx.wfPayslip.findFirst({ where: { ...org(context), id } });
    if (!p) throw notFound();
    const status = await advanceOne(tx, context, p);
    await audited(tx, context, `payslip.${status.toLowerCase().replace(' ', '_')}`, 'payslip', id);
    return { id, status };
  });
}
export async function confirmBatch(context, batch) {
  return withTenant(context, async (tx) => {
    const slips = await tx.wfPayslip.findMany({ where: { ...org(context), batch, status: 'Review Ongoing' } });
    if (!slips.length) throw new EmrError('INVALID_STATE', { message: 'No payslips in this batch are waiting for review.' });
    for (const p of slips) await advanceOne(tx, context, p);
    await audited(tx, context, 'payroll.batch_confirmed', 'payroll_batch', null, [batch, String(slips.length)]);
    return { batch, confirmed: slips.length };
  });
}
export async function addContract(context, input) {
  return withTenant(context, async (tx) => {
    await employee(tx, context, input.employeeId);
    const c = await tx.wfContract.create({ data: { ...(input.id ? { id: input.id } : {}), ...org(context), employeeId: input.employeeId, title: input.title, startDate: toDate(input.startDate), endDate: toDate(input.endDate), basicSalary: money(input.basicSalary), createdByUserId: context.userId } });
    await audited(tx, context, 'payroll.contract_added', 'contract', c.id);
    return { id: c.id };
  });
}

// ---- loans ------------------------------------------------------------------------------------------
async function loanCap(tx, context, employeeId) {
  const s = await tx.wfSalaryStructure.findFirst({ where: { ...org(context), employeeId } });
  if (!s) return null;
  const tiers = await tx.wfLoanTier.findMany({ where: org(context) });
  const basic = Number(s.basicSalary);
  const tier = tiers.find((t) => basic >= Number(t.minMonthlySalary) && (t.maxMonthlySalary === null || basic <= Number(t.maxMonthlySalary)));
  return tier ? Number(tier.maxLoanAmount) : null;
}
export async function requestLoan(context, input) {
  return withTenant(context, async (tx) => {
    await employee(tx, context, input.employeeId, { active: true });
    const cap = await loanCap(tx, context, input.employeeId);
    if (cap !== null && input.amount > cap) throw new EmrError('VALIDATION_FAILED', { message: `The most this employee can borrow at their salary is ₦${cap.toLocaleString('en-NG')}.` });
    const installmentAmount = money(Math.round(input.amount / input.installments));
    const l = await tx.wfLoan.create({
      data: {
        ...(input.id ? { id: input.id } : {}), ...org(context), employeeId: input.employeeId, type: input.type, amount: money(input.amount), installments: input.installments, installmentAmount,
        reason: input.reason, repaymentMethod: input.repaymentMethod, currentPeriodDue: installmentAmount, requestedByUserId: context.userId,
      },
    });
    await audited(tx, context, 'loan.requested', 'loan', l.id);
    return { id: l.id };
  });
}
async function loanOf(tx, context, id) {
  const l = await tx.wfLoan.findFirst({ where: { ...org(context), id } });
  if (!l) throw notFound();
  return l;
}
export async function decideLoan(context, id, { status }) {
  return withTenant(context, async (tx) => {
    const l = await loanOf(tx, context, id);
    if (l.status !== 'Requested') throw new EmrError('INVALID_STATE', { message: 'This loan has already been decided.' });
    await requireOtherDecider(tx, context, l);
    const now = new Date();
    await updateVersioned(tx.wfLoan, { organizationId: context.organizationId, id, expectedVersion: l.version, data: { status: status === 'Approved' ? 'Repaying' : 'Rejected', decidedByUserId: context.userId, decidedAt: now, ...(status === 'Approved' ? { periodStartDate: now } : {}) }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, `loan.${status.toLowerCase()}`, 'loan', id);
    return { id, status: status === 'Approved' ? 'Repaying' : 'Rejected' };
  });
}
export async function recordPayment(context, id, { amount, date }) {
  return withTenant(context, async (tx) => {
    const l = await loanOf(tx, context, id);
    if (!['Repaying', 'Overdue'].includes(l.status)) throw new EmrError('INVALID_STATE', { message: 'Only a loan being repaid takes payments.' });
    if (amount > money(Number(l.amount) - Number(l.totalPaid))) throw new EmrError('VALIDATION_FAILED', { message: 'That is more than the balance owed.' });
    await recordLoanPayment(tx, context, l, amount, toDate(date));
    await audited(tx, context, 'loan.payment_recorded', 'loan', id);
    return { id };
  });
}
export async function checkOverdue(context, id) {
  return withTenant(context, async (tx) => {
    const l = await loanOf(tx, context, id);
    if (!['Repaying', 'Overdue'].includes(l.status) || l.repaymentMethod !== 'Manual' || !l.periodStartDate) return { id, overdue: false };
    const days = Math.floor((Date.now() - l.periodStartDate.getTime()) / 86_400_000);
    if (days < PERIOD_DAYS || Number(l.currentPeriodPaid) >= Number(l.currentPeriodDue)) return { id, overdue: false };
    const shortfall = money(Number(l.currentPeriodDue) - Number(l.currentPeriodPaid));
    const missedPeriods = l.missedPeriods + 1;
    await updateVersioned(tx.wfLoan, { organizationId: context.organizationId, id, expectedVersion: l.version, data: { status: 'Overdue', missedPeriods, currentPeriodDue: money(Number(l.installmentAmount) + shortfall), currentPeriodPaid: 0, periodStartDate: new Date() }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'loan.overdue', 'loan', id);
    // A loan larger than a year's basic salary gets a formal letter (level 2 from the second miss).
    const s = await tx.wfSalaryStructure.findFirst({ where: { ...org(context), employeeId: l.employeeId } });
    let letter = null;
    if (Number(l.amount) > Number(s?.basicSalary ?? 0) * 12) {
      letter = await tx.wfLoanLetter.create({ data: { ...org(context), loanId: id, level: Math.min(missedPeriods, 2), amountOwed: shortfall } });
      await audited(tx, context, 'loan.letter_issued', 'loan', id, [String(letter.level)]);
    }
    return { id, overdue: true, letterId: letter?.id ?? null };
  });
}
export async function markLetterSent(context, id) {
  return withTenant(context, async (tx) => {
    const { count } = await tx.wfLoanLetter.updateMany({ where: { ...org(context), id, sent: false }, data: { sent: true, sentAt: new Date(), sentByUserId: context.userId } });
    if (!count) throw (await tx.wfLoanLetter.findFirst({ where: { ...org(context), id } })) ? new EmrError('INVALID_STATE', { message: 'This letter is already recorded as sent.' }) : notFound();
    await audited(tx, context, 'loan.letter_sent', 'loan_letter', id);
    return { id, sent: true };
  });
}
export async function addTier(context, { id, minMonthlySalary, maxMonthlySalary, maxLoanAmount }) {
  if (maxMonthlySalary !== null && maxMonthlySalary < minMonthlySalary) throw new EmrError('VALIDATION_FAILED', { message: 'The upper salary is below the lower one.' });
  return withTenant(context, async (tx) => {
    const tiers = await tx.wfLoanTier.findMany({ where: org(context) });
    const hi = maxMonthlySalary ?? Infinity;
    if (tiers.some((t) => minMonthlySalary <= (t.maxMonthlySalary === null ? Infinity : Number(t.maxMonthlySalary)) && Number(t.minMonthlySalary) <= hi)) throw new EmrError('VALIDATION_FAILED', { message: 'This salary band overlaps an existing tier.' });
    const t = await tx.wfLoanTier.create({ data: { ...(id ? { id } : {}), ...org(context), minMonthlySalary, maxMonthlySalary, maxLoanAmount } });
    await audited(tx, context, 'loan.tier_added', 'loan_tier', t.id);
    return { id: t.id };
  });
}

// ---- reimbursements ---------------------------------------------------------------------------------
export async function requestReimbursement(context, input) {
  return withTenant(context, async (tx) => {
    await employee(tx, context, input.employeeId, { active: true });
    const r = await tx.wfReimbursement.create({ data: { ...(input.id ? { id: input.id } : {}), ...org(context), employeeId: input.employeeId, type: input.type, title: input.title, amount: money(input.amount), requestedByUserId: context.userId } });
    await audited(tx, context, 'reimbursement.requested', 'reimbursement', r.id);
    return { id: r.id };
  });
}
export async function decideReimbursement(context, id, { status }) {
  return withTenant(context, async (tx) => {
    const r = await tx.wfReimbursement.findFirst({ where: { ...org(context), id } });
    if (!r) throw notFound();
    const allowed = status === 'Paid' ? r.status === 'Approved' : r.status === 'Requested';
    if (!allowed) throw new EmrError('INVALID_STATE', { message: status === 'Paid' ? 'Only an approved claim can be marked paid.' : 'This claim has already been decided.' });
    if (status !== 'Paid') await requireOtherDecider(tx, context, r);
    const now = new Date();
    await updateVersioned(tx.wfReimbursement, { organizationId: context.organizationId, id, expectedVersion: r.version, data: { status, ...(status === 'Paid' ? { paidAt: now } : { decidedByUserId: context.userId, decidedAt: now }) }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, `reimbursement.${status.toLowerCase()}`, 'reimbursement', id);
    return { id, status };
  });
}
