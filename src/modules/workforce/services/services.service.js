// HR services: company assets, the staff helpdesk and disciplinary queries.
//
// Who does what (enforced here):
//   - assets: HR (hr.read) sees the register; hr.manage keeps it, decides requests, allocates and takes
//     returns. Anyone may ask for an asset for themselves; HR may ask on someone's behalf. An asset is with
//     one person at a time; one returned damaged or lost is not available again;
//   - helpdesk: everyone raises tickets and sees the ones they raised or are assigned; HR sees all and
//     assigns; the assignees and HR move a ticket on. Everyone reads the FAQ; HR publishes it;
//   - queries: raised against an employee by their line manager or HR (never yourself), countersigned
//     through the organization's "query" workflow; only a signed query can be recorded as sent.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { nextSequence } from '../../emr/core/sequence.js';
import { instanceForReference, loadRoleHolders, registerTrigger, startInTx } from '../workflows/workflows.service.js';
import { requireListed } from '../../org-config/orgConfig.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const can = (context, permission) => context.permissions.includes(permission);
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : undefined);
const toDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00.000Z`) : null);
const notFound = () => new EmrError('HR_RECORD_NOT_FOUND');
const requireHr = (context) => { if (!can(context, 'hr.manage')) throw new EmrError('PERMISSION_DENIED'); };
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
const STARTER_FAQ_CATEGORIES = ['IT & Systems', 'HR & Payroll'];

async function me(tx, context) {
  return tx.wfEmployee.findFirst({ where: { ...org(context), userId: context.userId }, select: { id: true } });
}
async function activeEmployee(tx, context, id) {
  const e = await tx.wfEmployee.findFirst({ where: { ...org(context), id }, select: { id: true, name: true, status: true, reportingManagerId: true, departmentId: true } });
  if (!e) throw new EmrError('EMPLOYEE_NOT_FOUND');
  if (e.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: `${e.name} is not an active employee.` });
  return e;
}

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  return withTenant(context, async (tx) => {
    if (!(await tx.wfFaqCategory.count({ where: org(context) }))) await tx.wfFaqCategory.createMany({ data: STARTER_FAQ_CATEGORIES.map((name) => ({ ...org(context), name })) });
    const self = await me(tx, context);
    const hr = can(context, 'hr.read');
    const mine = self?.id ?? '-';
    const [categories, assets, requests, allocations, tickets, faqCategories, faqs, queries] = await Promise.all([
      tx.wfAssetCategory.findMany({ where: org(context), orderBy: { name: 'asc' } }),
      hr ? tx.wfCompanyAsset.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }) : [],
      tx.wfAssetRequest.findMany({ where: { ...org(context), ...(hr ? {} : { employeeId: mine }) }, orderBy: { requestedAt: 'desc' } }),
      tx.wfAssetAllocation.findMany({ where: { ...org(context), ...(hr ? {} : { employeeId: mine }) }, orderBy: { assignedAt: 'desc' } }),
      tx.wfTicket.findMany({ where: { ...org(context), ...(hr ? {} : { OR: [{ raisedByUserId: context.userId }, { assignedTo: { has: mine } }] }) }, orderBy: { createdAt: 'desc' } }),
      tx.wfFaqCategory.findMany({ where: org(context) }),
      tx.wfFaq.findMany({ where: org(context), orderBy: { createdAt: 'asc' } }),
      tx.wfQuery.findMany({ where: { ...org(context), ...(hr ? {} : { raisedByUserId: context.userId }) }, orderBy: { raisedAt: 'desc' } }),
    ]);
    // An employee sees the assets they hold, not the whole register.
    const held = hr ? assets : await tx.wfCompanyAsset.findMany({ where: { ...org(context), id: { in: allocations.map((a) => a.assetId) } } });
    return {
      selfEmployeeId: self?.id ?? null,
      categories: categories.map((c) => ({ id: c.id, name: c.name, description: c.description })),
      assets: held.map((a) => ({ id: a.id, name: a.name, categoryId: a.categoryId, batchNo: a.batchNo ?? undefined, trackingId: a.trackingId, purchaseDate: isoDay(a.purchaseDate), purchaseCost: Number(a.purchaseCost), status: a.status, expiryDate: isoDay(a.expiryDate) })),
      requests: requests.map((r) => ({ id: r.id, employeeId: r.employeeId, categoryId: r.categoryId, description: r.description, requestedDate: r.requestedAt, status: r.status })),
      allocations: allocations.map((a) => ({ id: a.id, assetId: a.assetId, employeeId: a.employeeId, assignedDate: a.assignedAt, returnDate: a.returnedAt ?? undefined, returnCondition: a.returnCondition ?? undefined, returnNote: a.returnNote ?? undefined })),
      tickets: tickets.map((t) => ({
        id: t.id, seq: t.seq, type: t.type, title: t.title, description: t.description, raisedBy: t.raisedByEmployeeId ?? `user-${t.raisedByUserId}`, assigningType: t.assigningType,
        raisedOn: t.raisedOn, assignedTo: t.assignedTo, priority: t.priority, status: t.status, createdAt: t.createdAt, resolvedAt: t.resolvedAt ?? undefined, version: t.version,
      })),
      faqCategories: faqCategories.map((c) => ({ id: c.id, name: c.name })),
      faqs: faqs.map((f) => ({ id: f.id, categoryId: f.categoryId, question: f.question, answer: f.answer })),
      queries: queries.map((q) => ({
        id: q.id, employeeId: q.employeeId, raisedBy: q.raisedByEmployeeId ?? `user-${q.raisedByUserId}`, subject: q.subject, body: q.body, status: q.status,
        raisedAt: q.raisedAt, sentAt: q.sentAt ?? undefined, responseDeadlineDays: q.responseDeadlineDays,
      })),
    };
  });
}

// ---- company assets ---------------------------------------------------------------------------------
export async function addCategory(context, { id, name, description }) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    let c;
    try { c = await tx.wfAssetCategory.create({ data: { ...(id ? { id } : {}), ...org(context), name, description: description ?? '' } }); } catch (error) { throw uniqueViolation(error, { name: 'HR_CODE_IN_USE', pkey: 'HR_CODE_IN_USE' }) ?? error; }
    await audited(tx, context, 'asset.category_added', 'asset_category', c.id);
    return { id: c.id };
  });
}
export async function addAsset(context, input) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    if (!(await tx.wfAssetCategory.findFirst({ where: { ...org(context), id: input.categoryId } }))) throw notFound();
    let a;
    try {
      a = await tx.wfCompanyAsset.create({
        data: { ...(input.id ? { id: input.id } : {}), ...org(context), name: input.name, categoryId: input.categoryId, batchNo: input.batchNo ?? null, trackingId: input.trackingId, purchaseDate: toDate(input.purchaseDate), purchaseCost: input.purchaseCost, expiryDate: toDate(input.expiryDate) },
      });
    } catch (error) { throw uniqueViolation(error, { tracking: 'HR_CODE_IN_USE', pkey: 'HR_CODE_IN_USE' }) ?? error; }
    await audited(tx, context, 'asset.added', 'company_asset', a.id);
    return { id: a.id };
  });
}
export async function requestAsset(context, { id, employeeId, categoryId, description }) {
  return withTenant(context, async (tx) => {
    const self = await me(tx, context);
    if (employeeId !== self?.id && !can(context, 'hr.manage')) throw new EmrError('PERMISSION_DENIED', { message: 'You can ask for an asset for yourself; HR asks on someone else\'s behalf.' });
    await activeEmployee(tx, context, employeeId);
    if (!(await tx.wfAssetCategory.findFirst({ where: { ...org(context), id: categoryId } }))) throw notFound();
    const r = await tx.wfAssetRequest.create({ data: { ...(id ? { id } : {}), ...org(context), employeeId, categoryId, description, requestedByUserId: context.userId } });
    await audited(tx, context, 'asset.requested', 'asset_request', r.id);
    return { id: r.id };
  });
}
export async function decideRequest(context, id, { status }) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    const r = await tx.wfAssetRequest.findFirst({ where: { ...org(context), id } });
    if (!r) throw notFound();
    if (r.status !== 'Requested') throw new EmrError('INVALID_STATE', { message: 'This request has already been decided.' });
    if (r.employeeId === (await me(tx, context))?.id) throw new EmrError('OWN_REQUEST');
    await updateVersioned(tx.wfAssetRequest, { organizationId: context.organizationId, id, expectedVersion: r.version, data: { status, decidedByUserId: context.userId, decidedAt: new Date() }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, `asset.request_${status.toLowerCase()}`, 'asset_request', id);
    return { id, status };
  });
}
export async function allocateAsset(context, { assetId, employeeId, requestId }) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    const asset = await tx.wfCompanyAsset.findFirst({ where: { ...org(context), id: assetId } });
    if (!asset) throw notFound();
    if (asset.status !== 'Available') throw new EmrError('INVALID_STATE', { message: `${asset.name} is not available.` });
    await activeEmployee(tx, context, employeeId);
    if (requestId) {
      const r = await tx.wfAssetRequest.findFirst({ where: { ...org(context), id: requestId } });
      if (!r || r.employeeId !== employeeId) throw notFound();
      if (r.status !== 'Approved') throw new EmrError('INVALID_STATE', { message: 'Only an approved request can be filled.' });
      await updateVersioned(tx.wfAssetRequest, { organizationId: context.organizationId, id: requestId, expectedVersion: r.version, data: { status: 'Allocated' }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    }
    try {
      await tx.wfAssetAllocation.create({ data: { ...org(context), assetId, employeeId, requestId: requestId ?? null, assignedByUserId: context.userId } });
    } catch (error) { throw uniqueViolation(error, { one_open: 'INVALID_STATE' }) ?? error; }
    await updateVersioned(tx.wfCompanyAsset, { organizationId: context.organizationId, id: assetId, expectedVersion: asset.version, data: { status: 'In Use' }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'asset.allocated', 'company_asset', assetId);
    return { assetId, employeeId };
  });
}
export async function returnAsset(context, allocationId, { condition, note }) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    const a = await tx.wfAssetAllocation.findFirst({ where: { ...org(context), id: allocationId } });
    if (!a) throw notFound();
    if (a.returnedAt) throw new EmrError('INVALID_STATE', { message: 'This asset has already been returned.' });
    await tx.wfAssetAllocation.updateMany({ where: { ...org(context), id: allocationId }, data: { returnedAt: new Date(), returnCondition: condition, returnNote: note ?? null, receivedByUserId: context.userId } });
    await tx.wfCompanyAsset.updateMany({ where: { ...org(context), id: a.assetId }, data: { status: condition === 'Good' ? 'Available' : 'Not Available', version: { increment: 1 } } });
    await audited(tx, context, 'asset.returned', 'company_asset', a.assetId, [condition]);
    return { id: allocationId, condition };
  });
}

// ---- helpdesk ---------------------------------------------------------------------------------------
export async function createTicket(context, input) {
  return withTenant(context, async (tx) => {
    await requireListed(tx, context, 'helpdesk-ticket-types', input.type, { what: 'The ticket type' });
    const self = await me(tx, context);
    if (input.assigningType === 'Individual') await activeEmployee(tx, context, input.raisedOn);
    const seq = await nextSequence(tx, context, 'helpdesk-ticket');
    const t = await tx.wfTicket.create({
      data: {
        ...(input.id ? { id: input.id } : {}), ...org(context), seq, type: input.type, title: input.title, description: input.description, raisedByUserId: context.userId, raisedByEmployeeId: self?.id ?? null,
        assigningType: input.assigningType, raisedOn: input.raisedOn, assignedTo: input.assigningType === 'Individual' ? [input.raisedOn] : [], priority: input.priority,
      },
    });
    await audited(tx, context, 'ticket.raised', 'ticket', t.id);
    return { id: t.id, seq };
  });
}
async function ticket(tx, context, id) {
  const t = await tx.wfTicket.findFirst({ where: { ...org(context), id } });
  if (!t) throw notFound();
  return t;
}
export async function setTicketStatus(context, id, { status }) {
  return withTenant(context, async (tx) => {
    const t = await ticket(tx, context, id);
    const self = await me(tx, context);
    if (!can(context, 'hr.manage') && !t.assignedTo.includes(self?.id)) throw new EmrError('PERMISSION_DENIED', { message: 'Only the people this ticket is assigned to (or HR) can move it on.' });
    await updateVersioned(tx.wfTicket, { organizationId: context.organizationId, id, expectedVersion: t.version, data: { status, resolvedAt: status === 'Resolved' ? new Date() : null }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, `ticket.${status.toLowerCase().replace(' ', '_')}`, 'ticket', id);
    return { id, status };
  });
}
export async function assignTicket(context, id, { staffIds }) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    const t = await ticket(tx, context, id);
    for (const staffId of staffIds) await activeEmployee(tx, context, staffId);
    await updateVersioned(tx.wfTicket, { organizationId: context.organizationId, id, expectedVersion: t.version, data: { assignedTo: [...new Set(staffIds)] }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'ticket.assigned', 'ticket', id);
    return { id };
  });
}
export async function addFaqCategory(context, { id, name }) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    const c = await tx.wfFaqCategory.create({ data: { ...(id ? { id } : {}), ...org(context), name } });
    return { id: c.id };
  });
}
export async function addFaq(context, { id, categoryId, question, answer }) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    if (!(await tx.wfFaqCategory.findFirst({ where: { ...org(context), id: categoryId } }))) throw notFound();
    const f = await tx.wfFaq.create({ data: { ...(id ? { id } : {}), ...org(context), categoryId, question, answer, createdByUserId: context.userId } });
    await audited(tx, context, 'faq.published', 'faq', f.id);
    return { id: f.id };
  });
}

// ---- disciplinary queries ---------------------------------------------------------------------------
async function querySubject(tx, context, q) {
  const emp = await tx.wfEmployee.findFirst({ where: { ...org(context), id: q.employeeId }, select: { name: true, departmentId: true } });
  return { subject: `Query — ${q.subject} (${emp?.name ?? 'employee'})`, subjectEmployeeId: q.employeeId, departmentId: emp?.departmentId ?? undefined, facts: { responseDeadlineDays: q.responseDeadlineDays } };
}
registerTrigger('query', {
  async load(tx, context, reference) {
    const q = await tx.wfQuery.findFirst({ where: { ...org(context), id: reference } });
    if (!q) throw notFound();
    if (q.raisedByUserId !== context.userId && !can(context, 'hr.manage')) throw new EmrError('PERMISSION_DENIED');
    if (q.status !== 'Drafted') throw new EmrError('INVALID_STATE', { message: 'This query has already been sent.' });
    return querySubject(tx, context, q);
  },
});
export async function raiseQuery(context, { id, employeeId, subject, body, responseDeadlineDays }) {
  const holders = await loadRoleHolders(context);
  return withTenant(context, async (tx) => {
    const self = await me(tx, context);
    const emp = await activeEmployee(tx, context, employeeId);
    if (emp.id === self?.id) throw new EmrError('OWN_REQUEST', { message: 'You cannot raise a query against yourself.' });
    if (!can(context, 'hr.manage') && emp.reportingManagerId !== self?.id) throw new EmrError('PERMISSION_DENIED', { message: 'Only the employee\'s line manager or HR can raise a query.' });
    const q = await tx.wfQuery.create({ data: { ...(id ? { id } : {}), ...org(context), employeeId, raisedByUserId: context.userId, raisedByEmployeeId: self?.id ?? null, subject, body, responseDeadlineDays } });
    await audited(tx, context, 'query.raised', 'query', q.id);
    await startInTx(tx, context, holders, { triggerType: 'query', reference: q.id, ...(await querySubject(tx, context, q)) });
    return { id: q.id };
  });
}
export async function markQuerySent(context, id) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    const q = await tx.wfQuery.findFirst({ where: { ...org(context), id } });
    if (!q) throw notFound();
    if (q.status === 'Sent') throw new EmrError('INVALID_STATE', { message: 'This query is already recorded as sent.' });
    if ((await instanceForReference(tx, context, 'query', id))?.status !== 'Approved') throw new EmrError('INVALID_STATE', { message: 'The query must be countersigned before it is sent.' });
    await updateVersioned(tx.wfQuery, { organizationId: context.organizationId, id, expectedVersion: q.version, data: { status: 'Sent', sentAt: new Date(), sentByUserId: context.userId }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'query.sent', 'query', id);
    return { id, status: 'Sent' };
  });
}
