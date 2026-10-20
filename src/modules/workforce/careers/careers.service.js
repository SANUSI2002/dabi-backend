// Careers: performance (objectives and key results, 360° feedback, 1-on-1s), promotions and branch transfers.
//
// Who does what (enforced here):
//   - HR (hr.read) sees everyone's performance records; anyone else sees the objectives, feedback and
//     meetings they are part of (as the employee or the manager);
//   - HR (hr.manage) sets review periods and objectives; HR or the stated manager starts feedback and
//     schedules 1-on-1s;
//   - key-result progress: the employee, the objective's managers or HR; objective status: managers or HR;
//   - a self-review is only the employee's own; a manager review only the stated manager's (HR when no
//     manager is set); a meeting is completed by its manager or HR;
//   - promotions and transfers are proposed by HR and approved through the organization's "promotion" /
//     "transfer" workflow (the employee's own line manager and department head are the approvers it
//     names); only an approved one can be applied, which changes the employee record.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { instanceForReference, loadRoleHolders, registerTrigger, startInTx } from '../workflows/workflows.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const can = (context, permission) => context.permissions.includes(permission);
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : undefined);
const toDate = (iso) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
const num = (v) => (v === null || v === undefined ? undefined : Number(v));
const notFound = () => new EmrError('HR_RECORD_NOT_FOUND');
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
const STARTER_KEY_RESULTS = [
  { title: 'Patients or clients reached', type: 'Numeric', targetValue: 40 },
  { title: 'Zero missed-checkout attendance incidents', type: 'Boolean', targetValue: 1 },
  { title: 'Monthly NHMIS return submitted on time', type: 'Percentage', targetValue: 100 },
];

async function me(tx, context) {
  return tx.wfEmployee.findFirst({ where: { ...org(context), userId: context.userId }, select: { id: true } });
}
async function requireEmployees(tx, context, ids, { active = true } = {}) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return;
  const found = await tx.wfEmployee.findMany({ where: { ...org(context), id: { in: unique } }, select: { id: true, status: true, name: true } });
  if (found.length !== unique.length) throw new EmrError('EMPLOYEE_NOT_FOUND');
  const inactive = active && found.find((e) => e.status !== 'ACTIVE');
  if (inactive) throw new EmrError('INVALID_STATE', { message: `${inactive.name} is not an active employee.` });
}
const requireHr = (context) => { if (!can(context, 'hr.manage')) throw new EmrError('PERMISSION_DENIED'); };

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  return withTenant(context, async (tx) => {
    if (!(await tx.wfKeyResult.count({ where: org(context) }))) await tx.wfKeyResult.createMany({ data: STARTER_KEY_RESULTS.map((k) => ({ ...org(context), ...k })) });
    const self = await me(tx, context);
    const hr = can(context, 'hr.read');
    const mine = self?.id ?? '-';
    const [periods, keyResults, objectives, employeeObjectives, feedbacks, meetings, promotions, transfers] = await Promise.all([
      tx.wfReviewPeriod.findMany({ where: org(context), orderBy: { startDate: 'desc' } }),
      tx.wfKeyResult.findMany({ where: org(context) }),
      tx.wfObjective.findMany({ where: { ...org(context), ...(hr ? {} : { OR: [{ assigneeIds: { has: mine } }, { managerIds: { has: mine } }] }) }, orderBy: { createdAt: 'desc' } }),
      tx.wfEmployeeObjective.findMany({ where: org(context) }),
      tx.wfFeedback.findMany({ where: { ...org(context), ...(hr ? {} : { OR: [{ employeeId: mine }, { managerId: mine }] }) }, orderBy: { startDate: 'desc' } }),
      tx.wfMeeting.findMany({ where: { ...org(context), ...(hr ? {} : { OR: [{ employeeId: mine }, { managerId: mine }] }) }, orderBy: { scheduledAt: 'desc' } }),
      hr ? tx.wfPromotion.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }) : [],
      hr ? tx.wfBranchTransfer.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }) : [],
    ]);
    const visibleObjectives = new Set(objectives.map((o) => o.id));
    const managersOf = new Map(objectives.map((o) => [o.id, o.managerIds]));
    const handover = (x) => ({ successorId: x.successorId ?? undefined, handoverNotes: x.handoverNotes ?? undefined, handoverStatus: x.handoverStatus, handoverCompletedAt: x.handoverCompletedAt ?? undefined });
    return {
      selfEmployeeId: self?.id ?? null,
      periods: periods.map((p) => ({ id: p.id, name: p.name, startDate: isoDay(p.startDate), endDate: isoDay(p.endDate) })),
      keyResults: keyResults.map((k) => ({ id: k.id, title: k.title, type: k.type, targetValue: Number(k.targetValue) })),
      objectives: objectives.map((o) => ({ id: o.id, title: o.title, description: o.description, managerIds: o.managerIds, assigneeIds: o.assigneeIds, keyResultIds: o.keyResultIds, durationUnit: o.durationUnit, duration: o.duration })),
      // An employee sees their own row of an objective they manage or are assigned to; managers see every row.
      employeeObjectives: employeeObjectives.filter((e) => visibleObjectives.has(e.objectiveId) && (hr || e.employeeId === mine || managersOf.get(e.objectiveId)?.includes(mine)))
        .map((e) => ({ id: e.id, objectiveId: e.objectiveId, employeeId: e.employeeId, startDate: e.startDate, endDate: e.endDate, status: e.status, progressPercentage: e.progress, keyResults: e.keyResults, version: e.version })),
      feedbacks: feedbacks.map((f) => ({
        id: f.id, reviewCycle: f.reviewCycle, employeeId: f.employeeId, managerId: f.managerId ?? undefined, colleagueIds: f.colleagueIds, status: f.status, startDate: f.startDate,
        endDate: f.endDate ?? undefined, selfAnswers: f.selfAnswers ?? undefined, managerAnswers: f.managerAnswers ?? undefined,
      })),
      meetings: meetings.map((m) => ({ id: m.id, title: m.title, employeeId: m.employeeId, managerId: m.managerId, scheduledAt: m.scheduledAt, status: m.status, notes: m.notes ?? undefined, actionItems: m.actionItems ?? undefined })),
      promotions: promotions.map((p) => ({
        id: p.id, employeeId: p.employeeId, fromJobPositionId: p.fromJobPositionId ?? undefined, fromJobRoleId: p.fromJobRoleId ?? undefined, fromCadre: p.fromCadre ?? undefined,
        toJobPositionId: p.toJobPositionId ?? undefined, toJobRoleId: p.toJobRoleId ?? undefined, toCadre: p.toCadre ?? undefined, newSalary: num(p.newSalary),
        effectiveDate: isoDay(p.effectiveDate), reason: p.reason, status: p.status, createdAt: p.createdAt, appliedAt: p.appliedAt ?? undefined, ...handover(p),
      })),
      transfers: transfers.map((t) => ({
        id: t.id, employeeId: t.employeeId, fromCompanyId: t.fromCompanyId ?? undefined, toCompanyId: t.toCompanyId, effectiveDate: isoDay(t.effectiveDate), reason: t.reason,
        status: t.status, createdAt: t.createdAt, appliedAt: t.appliedAt ?? undefined, ...handover(t),
      })),
    };
  });
}

// ---- performance ------------------------------------------------------------------------------------
export async function addPeriod(context, { id, name, startDate, endDate }) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    if (endDate < startDate) throw new EmrError('VALIDATION_FAILED', { message: 'The period ends before it starts.' });
    const p = await tx.wfReviewPeriod.create({ data: { ...(id ? { id } : {}), ...org(context), name, startDate: toDate(startDate), endDate: toDate(endDate) } });
    await audited(tx, context, 'review_period.added', 'review_period', p.id);
    return { id: p.id };
  });
}
const DAYS = { Days: 1, Months: 30, Years: 365 };
export async function addObjective(context, input) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    await requireEmployees(tx, context, [...input.assigneeIds, ...input.managerIds]);
    const krs = await tx.wfKeyResult.findMany({ where: { ...org(context), id: { in: input.keyResultIds } } });
    if (krs.length !== new Set(input.keyResultIds).size) throw notFound();
    const o = await tx.wfObjective.create({
      data: { ...(input.id ? { id: input.id } : {}), ...org(context), title: input.title, description: input.description ?? '', managerIds: input.managerIds, assigneeIds: input.assigneeIds, keyResultIds: input.keyResultIds, durationUnit: input.durationUnit, duration: input.duration, createdByUserId: context.userId },
    });
    const start = new Date();
    const end = new Date(start.getTime() + input.duration * DAYS[input.durationUnit] * 86_400_000);
    await tx.wfEmployeeObjective.createMany({
      data: input.assigneeIds.map((employeeId) => ({
        ...org(context), objectiveId: o.id, employeeId, startDate: start, endDate: end,
        keyResults: input.keyResultIds.map((krId, i) => { const kr = krs.find((k) => k.id === krId); return { id: `${o.id.slice(0, 8)}-${employeeId.slice(0, 8)}-${i}`, keyResultId: krId, title: kr.title, type: kr.type, currentValue: 0, targetValue: Number(kr.targetValue) }; }),
      })),
    });
    await audited(tx, context, 'objective.created', 'objective', o.id);
    return { id: o.id };
  });
}
async function employeeObjective(tx, context, id) {
  const eo = await tx.wfEmployeeObjective.findFirst({ where: { ...org(context), id } });
  if (!eo) throw notFound();
  const objective = await tx.wfObjective.findFirst({ where: { ...org(context), id: eo.objectiveId } });
  return { eo, objective };
}
export async function updateKeyResult(context, id, { keyResultId, currentValue }) {
  return withTenant(context, async (tx) => {
    const { eo, objective } = await employeeObjective(tx, context, id);
    const self = await me(tx, context);
    if (!can(context, 'hr.manage') && eo.employeeId !== self?.id && !objective.managerIds.includes(self?.id)) throw new EmrError('PERMISSION_DENIED');
    if (!eo.keyResults.some((k) => k.id === keyResultId)) throw notFound();
    const keyResults = eo.keyResults.map((k) => (k.id === keyResultId ? { ...k, currentValue } : k));
    const progress = Math.round(keyResults.reduce((n, k) => n + Math.min(100, (k.currentValue / (k.targetValue || 1)) * 100), 0) / keyResults.length);
    const status = progress >= 100 ? 'Closed' : progress > 0 ? (eo.status === 'Not Started' ? 'On Track' : eo.status) : 'Not Started';
    await updateVersioned(tx.wfEmployeeObjective, { organizationId: context.organizationId, id, expectedVersion: eo.version, data: { keyResults, progress, status }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'objective.progress_updated', 'employee_objective', id);
    return { id, progressPercentage: progress, status };
  });
}
export async function setObjectiveStatus(context, id, { status }) {
  return withTenant(context, async (tx) => {
    const { eo, objective } = await employeeObjective(tx, context, id);
    const self = await me(tx, context);
    if (!can(context, 'hr.manage') && !objective.managerIds.includes(self?.id)) throw new EmrError('PERMISSION_DENIED');
    await updateVersioned(tx.wfEmployeeObjective, { organizationId: context.organizationId, id, expectedVersion: eo.version, data: { status }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'objective.status_set', 'employee_objective', id, [status]);
    return { id, status };
  });
}
/** HR, or the person named as the manager, may start a review or a 1-on-1 with someone. */
async function requireHrOrManager(tx, context, managerId) {
  if (can(context, 'hr.manage')) return;
  const self = await me(tx, context);
  if (!self || self.id !== managerId) throw new EmrError('PERMISSION_DENIED');
}
export async function startFeedback(context, { id, reviewCycle, employeeId, managerId, colleagueIds }) {
  return withTenant(context, async (tx) => {
    await requireHrOrManager(tx, context, managerId);
    if (managerId === employeeId) throw new EmrError('VALIDATION_FAILED', { message: 'An employee cannot be their own reviewer.' });
    await requireEmployees(tx, context, [employeeId, managerId, ...colleagueIds]);
    const f = await tx.wfFeedback.create({ data: { ...(id ? { id } : {}), ...org(context), reviewCycle, employeeId, managerId: managerId ?? null, colleagueIds, startedByUserId: context.userId } });
    await audited(tx, context, 'feedback.started', 'feedback', f.id);
    return { id: f.id };
  });
}
export async function submitFeedback(context, id, { role, answers }) {
  return withTenant(context, async (tx) => {
    const f = await tx.wfFeedback.findFirst({ where: { ...org(context), id } });
    if (!f) throw notFound();
    const self = await me(tx, context);
    const mayAnswer = role === 'self' ? self?.id === f.employeeId : f.managerId ? self?.id === f.managerId : can(context, 'hr.manage');
    if (!mayAnswer) throw new EmrError('PERMISSION_DENIED', { message: role === 'self' ? 'Only the employee writes their self-review.' : 'Only the named manager writes the manager review.' });
    if ((role === 'self' ? f.selfAnswers : f.managerAnswers) !== null) throw new EmrError('INVALID_STATE', { message: 'This review has already been submitted.' });
    const data = role === 'self' ? { selfAnswers: answers } : { managerAnswers: answers };
    const closed = (role === 'self' || f.selfAnswers !== null) && (role === 'manager' || f.managerAnswers !== null);
    await updateVersioned(tx.wfFeedback, { organizationId: context.organizationId, id, expectedVersion: f.version, data: { ...data, ...(closed ? { status: 'Closed', endDate: new Date() } : {}) }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, `feedback.${role}_submitted`, 'feedback', id);
    return { id, status: closed ? 'Closed' : 'In Progress' };
  });
}
export async function scheduleMeeting(context, { id, title, employeeId, managerId, scheduledAt }) {
  return withTenant(context, async (tx) => {
    await requireHrOrManager(tx, context, managerId);
    if (managerId === employeeId) throw new EmrError('VALIDATION_FAILED', { message: 'A 1-on-1 needs two different people.' });
    await requireEmployees(tx, context, [employeeId, managerId]);
    const m = await tx.wfMeeting.create({ data: { ...(id ? { id } : {}), ...org(context), title, employeeId, managerId, scheduledAt: new Date(scheduledAt), createdByUserId: context.userId } });
    await audited(tx, context, 'meeting.scheduled', 'meeting', m.id);
    return { id: m.id };
  });
}
export async function completeMeeting(context, id, { notes, actionItems }) {
  return withTenant(context, async (tx) => {
    const m = await tx.wfMeeting.findFirst({ where: { ...org(context), id } });
    if (!m) throw notFound();
    await requireHrOrManager(tx, context, m.managerId);
    if (m.status === 'Completed') throw new EmrError('INVALID_STATE', { message: 'This meeting has already been recorded.' });
    await updateVersioned(tx.wfMeeting, { organizationId: context.organizationId, id, expectedVersion: m.version, data: { status: 'Completed', notes, actionItems: actionItems || null }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'meeting.completed', 'meeting', id);
    return { id, status: 'Completed' };
  });
}

// ---- promotions and transfers -----------------------------------------------------------------------
const KINDS = {
  promotion: { model: (tx) => tx.wfPromotion, trigger: 'promotion', resource: 'promotion' },
  transfer: { model: (tx) => tx.wfBranchTransfer, trigger: 'transfer', resource: 'branch_transfer' },
};
async function subjectFor(tx, context, kind, row) {
  const emp = await tx.wfEmployee.findFirst({ where: { ...org(context), id: row.employeeId }, select: { name: true, departmentId: true } });
  if (kind === 'promotion') {
    const position = row.toJobPositionId ? await tx.wfJobPosition.findFirst({ where: { ...org(context), id: row.toJobPositionId }, select: { name: true } }) : null;
    return { subject: `Promote ${emp?.name ?? 'employee'} to ${position?.name ?? row.toCadre ?? 'a new role'}`, departmentId: emp?.departmentId ?? undefined, facts: { newSalary: num(row.newSalary) ?? 0 } };
  }
  const company = await tx.wfCompany.findFirst({ where: { ...org(context), id: row.toCompanyId }, select: { name: true } });
  return { subject: `Transfer ${emp?.name ?? 'employee'} to ${company?.name ?? 'another branch'}`, departmentId: emp?.departmentId ?? undefined, facts: {} };
}
async function loadChange(tx, context, kind, id) {
  const row = await KINDS[kind].model(tx).findFirst({ where: { ...org(context), id } });
  if (!row) throw notFound();
  return row;
}
for (const kind of Object.keys(KINDS)) {
  registerTrigger(KINDS[kind].trigger, {
    async load(tx, context, reference) {
      requireHr(context);
      const row = await loadChange(tx, context, kind, reference);
      if (row.status !== 'Proposed') throw new EmrError('INVALID_STATE', { message: 'This change has already been applied.' });
      if ((await instanceForReference(tx, context, KINDS[kind].trigger, reference))?.status === 'Approved') throw new EmrError('INVALID_STATE', { message: 'This change is already approved; apply it.' });
      return { ...(await subjectFor(tx, context, kind, row)), subjectEmployeeId: row.employeeId };
    },
  });
}

export async function proposePromotion(context, input) {
  requireHr(context);
  const holders = await loadRoleHolders(context);
  return withTenant(context, async (tx) => {
    const emp = await tx.wfEmployee.findFirst({ where: { ...org(context), id: input.employeeId } });
    if (!emp) throw new EmrError('EMPLOYEE_NOT_FOUND');
    if (emp.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: `${emp.name} is not an active employee.` });
    if (input.toJobPositionId && !(await tx.wfJobPosition.findFirst({ where: { ...org(context), id: input.toJobPositionId } }))) throw notFound();
    if (input.toJobRoleId && !(await tx.wfJobRole.findFirst({ where: { ...org(context), id: input.toJobRoleId } }))) throw notFound();
    let row;
    try {
      row = await tx.wfPromotion.create({
        data: {
          ...(input.id ? { id: input.id } : {}), ...org(context), employeeId: emp.id, fromJobPositionId: emp.jobPositionId, fromJobRoleId: emp.jobRoleId, fromCadre: emp.cadre || null,
          toJobPositionId: input.toJobPositionId ?? null, toJobRoleId: input.toJobRoleId ?? null, toCadre: input.toCadre ?? null, newSalary: input.newSalary ?? null,
          effectiveDate: toDate(input.effectiveDate), reason: input.reason, requestedByUserId: context.userId,
        },
      });
    } catch (error) { throw uniqueViolation(error, { one_proposed: 'CHANGE_IN_FLIGHT', pkey: 'HR_CODE_IN_USE' }) ?? error; }
    await audited(tx, context, 'promotion.proposed', 'promotion', row.id);
    await startInTx(tx, context, holders, { triggerType: 'promotion', reference: row.id, subjectEmployeeId: emp.id, ...(await subjectFor(tx, context, 'promotion', row)) });
    return { id: row.id };
  });
}
export async function proposeTransfer(context, input) {
  requireHr(context);
  const holders = await loadRoleHolders(context);
  return withTenant(context, async (tx) => {
    const emp = await tx.wfEmployee.findFirst({ where: { ...org(context), id: input.employeeId } });
    if (!emp) throw new EmrError('EMPLOYEE_NOT_FOUND');
    if (emp.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: `${emp.name} is not an active employee.` });
    if (!(await tx.wfCompany.findFirst({ where: { ...org(context), id: input.toCompanyId } }))) throw notFound();
    if (emp.companyId === input.toCompanyId) throw new EmrError('VALIDATION_FAILED', { message: `${emp.name} is already at that branch.` });
    let row;
    try {
      row = await tx.wfBranchTransfer.create({
        data: { ...(input.id ? { id: input.id } : {}), ...org(context), employeeId: emp.id, fromCompanyId: emp.companyId, toCompanyId: input.toCompanyId, effectiveDate: toDate(input.effectiveDate), reason: input.reason, requestedByUserId: context.userId },
      });
    } catch (error) { throw uniqueViolation(error, { one_proposed: 'CHANGE_IN_FLIGHT', pkey: 'HR_CODE_IN_USE' }) ?? error; }
    await audited(tx, context, 'branch_transfer.proposed', 'branch_transfer', row.id);
    await startInTx(tx, context, holders, { triggerType: 'transfer', reference: row.id, subjectEmployeeId: emp.id, ...(await subjectFor(tx, context, 'transfer', row)) });
    return { id: row.id };
  });
}
export async function applyChange(context, kind, id) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    const row = await loadChange(tx, context, kind, id);
    if (row.status !== 'Proposed') throw new EmrError('INVALID_STATE', { message: 'This change has already been applied.' });
    if ((await instanceForReference(tx, context, KINDS[kind].trigger, id))?.status !== 'Approved') throw new EmrError('INVALID_STATE', { message: 'This change has not been approved.' });
    const employee = kind === 'promotion'
      ? Object.fromEntries(Object.entries({ jobPositionId: row.toJobPositionId, jobRoleId: row.toJobRoleId, cadre: row.toCadre }).filter(([, v]) => v))
      : { companyId: row.toCompanyId };
    await tx.wfEmployee.updateMany({ where: { ...org(context), id: row.employeeId }, data: { ...employee, version: { increment: 1 }, updatedAt: new Date() } });
    await updateVersioned(KINDS[kind].model(tx), { organizationId: context.organizationId, id, expectedVersion: row.version, data: { status: 'Effective', appliedAt: new Date() }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, `${KINDS[kind].resource}.applied`, KINDS[kind].resource, id, Object.keys(employee));
    await audited(tx, context, 'employee.updated', 'employee', row.employeeId, Object.keys(employee));
    return { id, status: 'Effective' };
  });
}
export async function recordHandover(context, kind, id, { successorId, notes, complete }) {
  requireHr(context);
  return withTenant(context, async (tx) => {
    const row = await loadChange(tx, context, kind, id);
    if (row.handoverStatus === 'Complete') throw new EmrError('INVALID_STATE', { message: 'The handover is already complete.' });
    let data;
    if (complete) {
      if (row.status !== 'Effective' || row.handoverStatus !== 'In progress') throw new EmrError('INVALID_STATE', { message: 'Apply the change and plan the handover first.' });
      data = { handoverStatus: 'Complete', handoverCompletedAt: new Date() };
    } else {
      if (successorId === row.employeeId) throw new EmrError('VALIDATION_FAILED', { message: 'The successor must be someone else.' });
      await requireEmployees(tx, context, [successorId]);
      data = { successorId, handoverNotes: notes || null, handoverStatus: 'In progress' };
    }
    await updateVersioned(KINDS[kind].model(tx), { organizationId: context.organizationId, id, expectedVersion: row.version, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, `${KINDS[kind].resource}.handover_${complete ? 'completed' : 'planned'}`, KINDS[kind].resource, id);
    return { id, handoverStatus: data.handoverStatus };
  });
}
