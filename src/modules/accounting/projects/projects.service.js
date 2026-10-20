// Projects (job costing) and each user's accounting notification preferences.
//
// Rules enforced here:
//   - a project code is unique; a billable project is tied to one of the organization's customers;
//   - time is logged by a member of staff against an open project; billable time needs a revenue account
//     and is pulled into an invoice once (receivables bills it); billed time cannot be removed;
//   - notification preferences are the signed-in user's own (they only filter the in-app alerts);
//   - acct.view reads; acct.post creates and changes projects and logs time.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { requireAcct } from '../ledger/ledger.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const audited = (tx, context, action, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType: 'project', resourceId, changedFields });
const iso = (d) => (d ? d.toISOString() : undefined);
const KEYS = ['approvalPending', 'invoiceOverdue', 'billDueSoon', 'lowStock', 'budgetExceeded', 'largeJournal'];

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    const [projects, entries, prefs] = await Promise.all([
      tx.acctProject.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }),
      tx.acctTimeEntry.findMany({ where: { ...org(context), removedAt: null }, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }] }),
      tx.acctNotificationPrefs.findUnique({ where: { organizationId_userId: { organizationId: context.organizationId, userId: context.userId } } }),
    ]);
    const names = await userNameMap(tx, projects.map((p) => p.createdByUserId));
    return {
      projects: projects.map((p) => ({
        id: p.id, code: p.code, name: p.name, customerId: p.customerId ?? undefined, status: p.status, startDate: iso(p.startDate), endDate: iso(p.endDate),
        budgetAmount: p.budgetAmount === null ? undefined : Number(p.budgetAmount), billable: p.billable, description: p.description ?? undefined,
        createdBy: names.get(p.createdByUserId) ?? 'Former member', createdAt: iso(p.createdAt), version: p.version,
      })),
      timeEntries: entries.map((t) => ({
        id: t.id, projectId: t.projectId, staffId: t.staffEmployeeId, date: iso(t.entryDate), hours: Number(t.hours), description: t.description, billable: t.billable,
        rate: t.rate === null ? undefined : Number(t.rate), revenueAccount: t.revenueAccount, status: t.status, invoiceId: t.invoiceId ?? undefined, createdAt: iso(t.createdAt),
      })),
      notificationPrefs: prefs?.prefs ?? null, // null: the defaults
    };
  });
}

// ---- projects ---------------------------------------------------------------------------------------
async function checkCustomer(tx, context, customerId) {
  if (customerId && !(await tx.acctCustomer.findFirst({ where: { ...org(context), id: customerId } }))) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Customer not found.' });
}
export async function addProject(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await checkCustomer(tx, context, input.customerId);
    try {
      const p = await tx.acctProject.create({
        data: {
          ...(input.id ? { id: input.id } : {}), ...org(context), code: input.code.toUpperCase(), name: input.name, customerId: input.customerId ?? null, status: input.status ?? 'Active',
          startDate: new Date(input.startDate), endDate: input.endDate ? new Date(input.endDate) : null, budgetAmount: input.budgetAmount ?? null, billable: input.billable, description: input.description ?? null, createdByUserId: context.userId,
        },
      });
      await audited(tx, context, 'project.created', p.id);
      return { id: p.id };
    } catch (error) { throw uniqueViolation(error, { code_key: 'HR_CODE_IN_USE', pkey: 'HR_CODE_IN_USE' }) ?? error; }
  });
}
export async function updateProject(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await checkCustomer(tx, context, patch.customerId);
    const data = Object.fromEntries(Object.entries({
      ...patch, startDate: patch.startDate ? new Date(patch.startDate) : undefined, endDate: patch.endDate === null ? null : patch.endDate ? new Date(patch.endDate) : undefined,
    }).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.acctProject, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'project.updated', id, Object.keys(data));
    return { id };
  });
}

// ---- time -------------------------------------------------------------------------------------------
export async function addTimeEntry(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const p = await tx.acctProject.findFirst({ where: { ...org(context), id: input.projectId } });
    if (!p) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Project not found.' });
    if (p.status === 'Completed' || p.status === 'Cancelled') throw new EmrError('INVALID_STATE', { message: `This project is ${p.status.toLowerCase()}.` });
    if (!(await tx.wfEmployee.findFirst({ where: { ...org(context), id: input.staffId } }))) throw new EmrError('EMPLOYEE_NOT_FOUND');
    const acct = await tx.acctAccount.findFirst({ where: { ...org(context), number: input.revenueAccount } });
    if (!acct || !acct.isActive || acct.type !== 'revenue') throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${input.revenueAccount} is not an available revenue account.` });
    const t = await tx.acctTimeEntry.create({
      data: {
        ...(input.id ? { id: input.id } : {}), ...org(context), projectId: p.id, staffEmployeeId: input.staffId, entryDate: new Date(input.date), hours: input.hours, description: input.description,
        billable: input.billable, rate: input.billable ? input.rate ?? 0 : null, revenueAccount: input.revenueAccount, status: input.billable ? 'Unbilled' : 'Non-billable', createdByUserId: context.userId,
      },
    });
    await audited(tx, context, 'project.time_logged', p.id, [String(input.hours)]);
    return { id: t.id };
  });
}
export async function removeTimeEntry(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const { count } = await tx.acctTimeEntry.updateMany({ where: { ...org(context), id, removedAt: null, status: { not: 'Invoiced' } }, data: { removedAt: new Date() } });
    if (!count) throw new EmrError('INVALID_STATE', { message: 'That time has been invoiced or is already removed.' });
    await audited(tx, context, 'project.time_removed', id);
    return { id };
  });
}

/** Invoice lines for unbilled time on the customer's project; called by receivables inside its transaction. */
export async function timeLinesForInvoice(tx, context, { customerId, timeEntryIds }) {
  const entries = await tx.acctTimeEntry.findMany({ where: { ...org(context), id: { in: timeEntryIds }, status: 'Unbilled', removedAt: null } });
  const projects = await tx.acctProject.findMany({ where: { ...org(context), id: { in: [...new Set(entries.map((t) => t.projectId))] } } });
  if (entries.length !== timeEntryIds.length || projects.some((p) => p.customerId !== customerId)) throw new EmrError('INVALID_STATE', { message: "Some of that time is already billed or belongs to another customer's project." });
  return entries.map((t) => ({ accountNumber: t.revenueAccount, description: `${t.description} (${Number(t.hours)}h)`, qty: Number(t.hours), unitPrice: Number(t.rate ?? 0), taxRateId: 'tax-vat-exempt' }));
}

// ---- notification preferences -----------------------------------------------------------------------
export async function savePrefs(context, prefs) {
  requireAcct(context, 'acct.view');
  const clean = Object.fromEntries(KEYS.filter((k) => typeof prefs[k] === 'boolean').map((k) => [k, prefs[k]]));
  return withTenant(context, async (tx) => {
    await tx.acctNotificationPrefs.upsert({
      where: { organizationId_userId: { organizationId: context.organizationId, userId: context.userId } },
      create: { ...org(context), userId: context.userId, prefs: clean }, update: { prefs: clean, updatedAt: new Date() },
    });
    return { prefs: clean };
  });
}
