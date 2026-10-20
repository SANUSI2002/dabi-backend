// Approval workflows: definitions (the Workflow Builder), instances (requests in flight), decisions
// (the Approvals inbox) and escalation.
//
// Rules enforced here:
//   - who approves a step is worked out by the server from the organization's records: the requester's
//     line manager, the department's HOD/deputy, or the employees holding a role — never from the
//     browser. A step nobody can take (no manager set, no one with the role) goes to HR, then the
//     hospital administrator, and the trail says so;
//   - only an employee who can sign in (linked to a Sabi account) can approve, and never their own
//     request (except an explicit "initiator" step);
//   - an instance runs on the snapshot of the graph it started with; editing a definition does not
//     move requests already in flight. One request in flight per document.
// A request is started by the module that owns the document (vacancies, onboarding, …), which
// registers how to read the document's facts and what an outcome does. A Workflow Builder test run
// (workflow.manage) uses the context typed in and is marked as a test.
import { randomUUID } from 'node:crypto';
import prisma from '../../../config/db.js';
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import * as engine from './workflow.engine.js';
import { STARTER_WORKFLOWS } from './workflow.seed.js';

const org = (context) => ({ organizationId: context.organizationId });
const canManage = (context) => context.permissions.includes('workflow.manage');

// Role names used in workflow steps → the Sabi roles that hold them.
const ROLE_LABELS = {
  'hr administrator': ['HR_OFFICER'], 'hr officer': ['HR_OFFICER'], hr: ['HR_OFFICER'],
  'finance controller': ['FINANCE_OFFICER'], 'finance officer': ['FINANCE_OFFICER'],
  'executive director': ['HOSPITAL_ADMIN', 'ORGANISATION_OWNER'], 'medical director': ['HOSPITAL_ADMIN', 'ORGANISATION_OWNER'],
  'hospital administrator': ['HOSPITAL_ADMIN'], owner: ['ORGANISATION_OWNER'],
};
const roleCodes = (ref) => ROLE_LABELS[ref.trim().toLowerCase()] ?? [ref.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')];
const FALLBACK = [{ codes: ['HR_OFFICER'], to: 'HR' }, { codes: ['HOSPITAL_ADMIN', 'ORGANISATION_OWNER'], to: 'the hospital administrator' }];

// ---- triggers: the modules whose documents go through approval ------------------------------------
// handler.load(tx, context, reference) → { subject, subjectEmployeeId?, departmentId?, facts }  (checks the caller may raise it)
// handler.started?(tx, context, instance)              the request is now in flight (or already decided)
// handler.complete?(tx, context, instance, outcome)    outcome: 'approved' | 'rejected' | 'cancelled'
const TRIGGERS = new Map();
export function registerTrigger(type, handler) { TRIGGERS.set(type, handler); }
export const connectedTriggers = () => [...TRIGGERS.keys()];

/** Sign-in users per role in this organization. Read before the tenant transaction (single connection). */
export async function loadRoleHolders(context) {
  const memberships = await prisma.organizationMembership.findMany({
    where: { organizationId: context.organizationId, status: 'ACTIVE', user: { accountStatus: 'ACTIVE' } },
    select: { userId: true, roles: { select: { roleCode: true } } },
  });
  const holders = new Map();
  for (const m of memberships) for (const { roleCode } of m.roles) holders.set(roleCode, [...(holders.get(roleCode) ?? []), m.userId]);
  return holders;
}

async function peopleOf(tx, context) {
  const [employees, departments] = await Promise.all([
    tx.wfEmployee.findMany({ where: org(context), select: { id: true, userId: true, name: true, status: true, departmentId: true, reportingManagerId: true } }),
    tx.wfDepartment.findMany({ where: org(context), select: { id: true, hodEmployeeId: true, deputyHodEmployeeId: true } }),
  ]);
  const byId = new Map(employees.map((e) => [e.id, e]));
  return { employees, departments, byId, me: employees.find((e) => e.userId === context.userId) ?? null };
}

/** The people facts every request carries, worked out from the records. */
function peopleContext(people, initiator, { subjectEmployeeId, departmentId }) {
  const subject = people.byId.get(subjectEmployeeId ?? initiator?.id) ?? null;
  const deptId = departmentId ?? subject?.departmentId ?? null;
  const dept = people.departments.find((d) => d.id === deptId);
  return clean({
    initiatorId: initiator?.id, subjectEmployeeId: subject?.id, lineManagerId: subject?.reportingManagerId,
    departmentId: deptId, hodId: dept?.hodEmployeeId, deputyHodId: dept?.deputyHodEmployeeId,
  });
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

function resolver(people, holders, ctx) {
  const able = (id) => { const e = people.byId.get(id); return !!e && e.status === 'ACTIVE' && !!e.userId; };
  const holdersOf = (codes) => {
    const users = new Set(codes.flatMap((c) => holders.get(c) ?? []));
    return people.employees.filter((e) => able(e.id) && users.has(e.userId)).sort((a, b) => a.name.localeCompare(b.name)).map((e) => e.id);
  };
  return (type, ref, label) => {
    const named = {
      initiator: ['Initiator', [ctx.initiatorId]], 'line-manager': ['Line manager', [ctx.lineManagerId]], hod: ['Head of Department', [ctx.hodId]],
      'deputy-hod': ['Deputy HOD', [ctx.deputyHodId]], 'specific-person': ['Named approver', [ref]],
    }[type];
    const who = named ? named[0] : ref || label || 'Approver';
    let ids = named ? named[1] : ref ? holdersOf(roleCodes(ref)) : [];
    ids = ids.filter((id) => id && able(id) && (type === 'initiator' || id !== ctx.initiatorId));
    if (ids.length) return { ids, label: who };
    for (const f of FALLBACK) {
      const others = holdersOf(f.codes).filter((id) => id !== ctx.initiatorId);
      if (others.length) return { ids: others, label: `${who} (routed to ${f.to})`, note: `No ${who.toLowerCase()} who can sign in — routed to ${f.to}` };
    }
    return { ids: [], label: who, note: `No one can decide "${label}" yet` };
  };
}

// ---- events -----------------------------------------------------------------------------------------
function trail(context, me) {
  const events = [];
  const base = Date.now();
  return {
    events,
    push: (nodeId, nodeLabel, action, extra = {}) => events.push({ nodeId, nodeLabel: String(nodeLabel).slice(0, 160), action, ...extra, comment: extra.comment ? String(extra.comment).slice(0, 500) : null, createdAt: new Date(base + events.length) }),
    actor: { actorUserId: context.userId, actorEmployeeId: me?.id ?? null },
    save: (tx, instanceId) => (events.length ? tx.wfWorkflowEvent.createMany({ data: events.map((e) => ({ ...org(context), instanceId, ...e })) }) : null),
  };
}
const entered = (log, graph, active) => { for (const a of active) log.push(a.nodeId, engine.nodeById(graph, a.nodeId)?.label ?? a.nodeId, 'entered', { comment: a.approverLabel }); };

async function finish(tx, context, instance, outcome) {
  const handler = TRIGGERS.get(instance.triggerType);
  if (!instance.isTest && handler?.complete) await handler.complete(tx, context, instance, outcome);
}

// ---- starting ---------------------------------------------------------------------------------------
/** Starts a request inside the caller's tenant transaction. `holders` from loadRoleHolders(). */
export async function startInTx(tx, context, holders, { id, triggerType, reference, subject, subjectEmployeeId, departmentId, facts = {}, defId, testContext }) {
  await ensureStarters(tx, context);
  const people = await peopleOf(tx, context);
  const def = defId
    ? await tx.wfWorkflowDef.findFirst({ where: { ...org(context), id: defId } })
    : await tx.wfWorkflowDef.findFirst({ where: { ...org(context), triggerType, active: true }, orderBy: { createdAt: 'desc' } });
  if (!def) throw new EmrError(defId ? 'WORKFLOW_NOT_FOUND' : 'WORKFLOW_NOT_CONFIGURED');
  const graph = { nodes: def.nodes, edges: def.edges };
  const errors = engine.validateDef(graph);
  if (errors.length) throw new EmrError('WORKFLOW_INVALID', { details: { errors } });
  if (await tx.wfWorkflowInstance.findFirst({ where: { ...org(context), triggerType: def.triggerType, reference, status: 'Running' }, select: { id: true } })) throw new EmrError('WORKFLOW_ALREADY_RUNNING');

  const ctx = testContext ? { ...testContext } : { ...facts, ...peopleContext(people, people.me, { subjectEmployeeId, departmentId }) };
  const log = trail(context, people.me);
  const sn = engine.startNode(graph);
  log.push(sn.id, sn.label, 'started', log.actor);
  const res = engine.walkFrom(graph, sn.id, 'default', ctx, resolver(people, holders, ctx), (n, note) => log.push(n.id, n.label, 'auto', { comment: note }));
  entered(log, graph, res.active);
  if (res.ended) log.push('end', 'Workflow', 'completed', { comment: res.ended });
  const status = res.ended ? (res.ended === 'approved' ? 'Approved' : 'Rejected') : 'Running';
  let instance;
  try {
    instance = await tx.wfWorkflowInstance.create({
      data: {
        ...(id ? { id } : {}), ...org(context), defId: def.id, defName: def.name, defVersion: def.version, graph, triggerType: def.triggerType, subject: subject.slice(0, 300), reference, context: ctx,
        isTest: !!testContext, initiatedByUserId: context.userId, initiatedByEmployeeId: people.me?.id ?? null, status, active: res.active, completedAt: res.ended ? new Date() : null,
      },
    });
  } catch (error) {
    throw uniqueViolation(error, { one_running: 'WORKFLOW_ALREADY_RUNNING' }) ?? error;
  }
  await log.save(tx, instance.id);
  await recordAudit(tx, context, { action: 'workflow.started', resourceType: 'workflow_instance', resourceId: instance.id, changedFields: [def.triggerType] });
  if (res.ended) await finish(tx, context, instance, res.ended);
  return instance;
}

/** Starts approval for a document of a connected kind, or a Builder test run. */
export async function start(context, { id, triggerType, reference, subject, defId, context: testContext }) {
  const test = !!testContext;
  if (test && !canManage(context)) throw new EmrError('PERMISSION_DENIED');
  const handler = TRIGGERS.get(triggerType);
  if (!test && !handler) throw new EmrError('WORKFLOW_TRIGGER_NOT_CONNECTED');
  const holders = await loadRoleHolders(context);
  return withTenant(context, async (tx) => {
    const facts = test ? {} : await handler.load(tx, context, reference);
    const instance = await startInTx(tx, context, holders, test
      ? { id, triggerType, reference: `test-${randomUUID()}`, subject: subject ?? 'Test run', defId, testContext }
      : { id, triggerType, reference, subject: facts.subject ?? subject ?? reference, subjectEmployeeId: facts.subjectEmployeeId, departmentId: facts.departmentId, facts: facts.facts });
    if (!test) await handler.started?.(tx, context, instance);
    return { instanceId: instance.id, status: instance.status, autoApproved: instance.status === 'Approved' };
  });
}

// ---- deciding ---------------------------------------------------------------------------------------
export async function decide(context, instanceId, { nodeId, decision, comment }) {
  const holders = await loadRoleHolders(context);
  return withTenant(context, async (tx) => {
    const inst = await tx.wfWorkflowInstance.findFirst({ where: { ...org(context), id: instanceId } });
    if (!inst) throw new EmrError('WORKFLOW_NOT_FOUND');
    if (inst.status !== 'Running') throw new EmrError('WORKFLOW_NOT_RUNNING');
    const people = await peopleOf(tx, context);
    if (!people.me) throw new EmrError('NO_EMPLOYEE_RECORD');
    const graph = inst.graph;
    const node = engine.nodeById(graph, nodeId);
    const active = structuredClone(inst.active);
    const step = active.find((a) => a.nodeId === nodeId);
    if (!node || !step) throw new EmrError('INVALID_STATE', { message: 'That step is not waiting for a decision.' });
    const log = trail(context, people.me);
    const action = decision === 'approve' ? 'approved' : 'rejected';
    let branch;
    if (node.type === 'parallel') {
      const part = step.memberDecisions.find((m) => m.decision === 'pending' && m.approverIds.includes(people.me.id));
      if (!part) throw new EmrError('WORKFLOW_STEP_NOT_YOURS');
      Object.assign(part, { decision: action, at: new Date().toISOString(), decidedBy: people.me.id });
      log.push(nodeId, node.label, action, { ...log.actor, comment: comment ?? part.label });
      branch = engine.parallelOutcome(node, step.memberDecisions);
    } else {
      if (!step.approverIds.includes(people.me.id)) throw new EmrError(inst.initiatedByUserId === context.userId ? 'OWN_REQUEST' : 'WORKFLOW_STEP_NOT_YOURS');
      log.push(nodeId, node.label, action, { ...log.actor, comment });
      branch = decision;
    }
    let next = active;
    let ended;
    if (branch) {
      const res = engine.walkFrom(graph, nodeId, branch, inst.context, resolver(people, holders, inst.context), (n, note) => log.push(n.id, n.label, 'auto', { comment: note }));
      entered(log, graph, res.active);
      next = active.filter((a) => a.nodeId !== nodeId).concat(res.active);
      ended = res.ended ?? (next.length === 0 ? 'approved' : undefined);
    }
    if (ended) log.push('end', 'Workflow', 'completed', { comment: ended });
    const data = ended ? { status: ended === 'approved' ? 'Approved' : 'Rejected', active: [], completedAt: new Date() } : { active: next };
    await updateVersioned(tx.wfWorkflowInstance, { organizationId: context.organizationId, id: instanceId, expectedVersion: inst.version, data, notFoundCode: 'WORKFLOW_NOT_FOUND' });
    await log.save(tx, instanceId);
    await recordAudit(tx, context, { action: `workflow.step_${action}`, resourceType: 'workflow_instance', resourceId: instanceId, changedFields: [nodeId] });
    if (ended) await finish(tx, context, { ...inst, ...data }, ended);
    return { id: instanceId, status: data.status ?? 'Running' };
  });
}

export async function cancelInTx(tx, context, inst, reason) {
  if (inst.status !== 'Running') throw new EmrError('WORKFLOW_NOT_RUNNING');
  const me = await tx.wfEmployee.findFirst({ where: { ...org(context), userId: context.userId }, select: { id: true } });
  const log = trail(context, me);
  log.push('-', 'Workflow', 'cancelled', { ...log.actor, comment: reason });
  const data = { status: 'Cancelled', active: [], completedAt: new Date() };
  await updateVersioned(tx.wfWorkflowInstance, { organizationId: context.organizationId, id: inst.id, expectedVersion: inst.version, data, notFoundCode: 'WORKFLOW_NOT_FOUND' });
  await log.save(tx, inst.id);
  await recordAudit(tx, context, { action: 'workflow.cancelled', resourceType: 'workflow_instance', resourceId: inst.id });
  await finish(tx, context, { ...inst, ...data }, 'cancelled');
}
export async function cancel(context, instanceId, { reason }) {
  return withTenant(context, async (tx) => {
    const inst = await tx.wfWorkflowInstance.findFirst({ where: { ...org(context), id: instanceId } });
    if (!inst) throw new EmrError('WORKFLOW_NOT_FOUND');
    if (inst.initiatedByUserId !== context.userId && !canManage(context)) throw new EmrError('PERMISSION_DENIED');
    await cancelInTx(tx, context, inst, reason);
    return { id: instanceId, status: 'Cancelled' };
  });
}
/** Withdraws the request in flight for a document, if any (used when the document is withdrawn). */
export async function cancelForReference(tx, context, triggerType, reference, reason) {
  const inst = await tx.wfWorkflowInstance.findFirst({ where: { ...org(context), triggerType, reference, status: 'Running' } });
  if (inst) await cancelInTx(tx, context, inst, reason);
}
/** The comment on the last rejection of an instance (the reason a document was sent back). */
export async function rejectionComment(tx, context, instanceId) {
  const event = await tx.wfWorkflowEvent.findFirst({ where: { ...org(context), instanceId, action: 'rejected' }, orderBy: { createdAt: 'desc' } });
  return event?.comment ?? null;
}
export const instanceForReference = (tx, context, triggerType, reference) =>
  tx.wfWorkflowInstance.findFirst({ where: { ...org(context), triggerType, reference }, orderBy: { createdAt: 'desc' } });

// ---- escalation -------------------------------------------------------------------------------------
async function escalate(tx, context, holders, now = new Date()) {
  const running = await tx.wfWorkflowInstance.findMany({ where: { ...org(context), status: 'Running' } });
  let escalated = 0;
  let people;
  for (const inst of running) {
    const graph = inst.graph;
    const due = inst.active.filter((a) => {
      const node = engine.nodeById(graph, a.nodeId);
      const t = node && (node.type === 'approval' || node.type === 'review') ? engine.timeoutOf(graph, a.nodeId) : null;
      return t && now.getTime() - new Date(a.enteredAt).getTime() >= t.hours * 3_600_000;
    });
    if (!due.length) continue;
    people ??= await peopleOf(tx, context);
    const log = trail(context, null);
    let active = inst.active;
    let ended;
    for (const a of due) {
      const node = engine.nodeById(graph, a.nodeId);
      log.push(a.nodeId, node.label, 'escalated', { comment: `no response in ${engine.timeoutOf(graph, a.nodeId).hours}h` });
      const res = engine.walkFrom(graph, a.nodeId, 'timeout', inst.context, resolver(people, holders, inst.context), (n, note) => log.push(n.id, n.label, 'auto', { comment: note }), now);
      entered(log, graph, res.active);
      active = active.filter((x) => x.nodeId !== a.nodeId).concat(res.active);
      ended ??= res.ended;
      escalated += 1;
    }
    if (ended) log.push('end', 'Workflow', 'completed', { comment: ended });
    const data = ended ? { status: ended === 'approved' ? 'Approved' : 'Rejected', active: [], completedAt: now } : { active };
    await updateVersioned(tx.wfWorkflowInstance, { organizationId: context.organizationId, id: inst.id, expectedVersion: inst.version, data, notFoundCode: 'WORKFLOW_NOT_FOUND' });
    await log.save(tx, inst.id);
    if (ended) await finish(tx, context, { ...inst, ...data }, ended);
  }
  return escalated;
}
export async function runEscalations(context) {
  const holders = await loadRoleHolders(context);
  return withTenant(context, async (tx) => {
    const escalated = await escalate(tx, context, holders);
    if (escalated) await recordAudit(tx, context, { action: 'workflow.escalated', resourceType: 'workflow_instance', changedFields: [String(escalated)] });
    return { escalated };
  });
}

// ---- definitions ------------------------------------------------------------------------------------
async function ensureStarters(tx, context) {
  if (await tx.wfWorkflowDef.count({ where: org(context) })) return;
  await tx.wfWorkflowDef.createMany({
    data: STARTER_WORKFLOWS.map(({ key, ...d }) => ({ ...org(context), starterKey: key, name: d.name, description: d.description, triggerType: d.triggerType, active: true, nodes: d.nodes, edges: d.edges })),
    skipDuplicates: true,
  });
}
export async function createDef(context, { id, name, triggerType, description }) {
  return withTenant(context, async (tx) => {
    const def = await tx.wfWorkflowDef.create({
      data: {
        ...(id ? { id } : {}), ...org(context), name, triggerType, description: description || null, active: false, createdByUserId: context.userId,
        nodes: [
          { id: 'start', type: 'start', label: 'Start', x: 60, y: 160 },
          { id: 'end-ok', type: 'end', label: 'Approved', x: 520, y: 100, outcome: 'approved' },
          { id: 'end-no', type: 'end', label: 'Rejected', x: 520, y: 260, outcome: 'rejected' },
        ],
        edges: [],
      },
    });
    await recordAudit(tx, context, { action: 'workflow.def_created', resourceType: 'workflow_def', resourceId: def.id, changedFields: [triggerType] });
    return { id: def.id, version: def.version };
  });
}
export async function saveDef(context, id, expectedVersion, patch) {
  return withTenant(context, async (tx) => {
    const def = await tx.wfWorkflowDef.findFirst({ where: { ...org(context), id } });
    if (!def) throw new EmrError('WORKFLOW_NOT_FOUND');
    const next = { nodes: patch.nodes ?? def.nodes, edges: patch.edges ?? def.edges };
    const errors = engine.validateDef(next);
    if (def.active && errors.length) throw new EmrError('WORKFLOW_INVALID', { message: 'This workflow is switched on; fix its errors (or switch it off) before saving.', details: { errors } });
    const data = clean({ name: patch.name, description: patch.description, triggerType: patch.triggerType, nodes: patch.nodes, edges: patch.edges });
    const row = await updateVersioned(tx.wfWorkflowDef, { organizationId: context.organizationId, id, expectedVersion, data: { ...data, updatedAt: new Date() }, notFoundCode: 'WORKFLOW_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'workflow.def_updated', resourceType: 'workflow_def', resourceId: id, changedFields: Object.keys(data) });
    return { id, version: row?.version ?? expectedVersion + 1, errors };
  });
}
export async function setDefActive(context, id, { active }) {
  return withTenant(context, async (tx) => {
    const def = await tx.wfWorkflowDef.findFirst({ where: { ...org(context), id } });
    if (!def) throw new EmrError('WORKFLOW_NOT_FOUND');
    if (active) {
      const errors = engine.validateDef(def);
      if (errors.length) throw new EmrError('WORKFLOW_INVALID', { details: { errors } });
    }
    await tx.wfWorkflowDef.updateMany({ where: { ...org(context), id }, data: { active, version: { increment: 1 }, updatedAt: new Date() } });
    await recordAudit(tx, context, { action: active ? 'workflow.def_activated' : 'workflow.def_deactivated', resourceType: 'workflow_def', resourceId: id });
    return { id, active };
  });
}

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  const holders = await loadRoleHolders(context);
  return withTenant(context, async (tx) => {
    await ensureStarters(tx, context);
    await escalate(tx, context, holders);
    const people = await peopleOf(tx, context);
    const me = people.me;
    const [defs, rows] = await Promise.all([
      tx.wfWorkflowDef.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }),
      tx.wfWorkflowInstance.findMany({ where: org(context), orderBy: { createdAt: 'desc' }, take: 300 }),
    ]);
    const events = rows.length ? await tx.wfWorkflowEvent.findMany({ where: { ...org(context), instanceId: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } }) : [];
    const names = await userNameMap(tx, [...rows.map((r) => r.initiatedByUserId), ...events.map((e) => e.actorUserId), ...defs.map((d) => d.createdByUserId)]);
    const person = (employeeId, userId) => employeeId ?? (userId ? names.get(userId) ?? 'Former member' : undefined);
    const involves = (r) => r.initiatedByUserId === context.userId || (me && (
      r.active.some((a) => a.approverIds?.includes(me.id) || a.memberDecisions?.some((m) => m.approverIds?.includes(me.id))) ||
      events.some((e) => e.instanceId === r.id && e.actorEmployeeId === me.id)));
    const visible = canManage(context) ? rows : rows.filter(involves);
    const inbox = [];
    for (const r of visible) {
      if (r.status !== 'Running' || !me) continue;
      for (const a of r.active) {
        const mine = a.memberDecisions ? a.memberDecisions.some((m) => m.decision === 'pending' && m.approverIds?.includes(me.id)) : a.approverIds?.includes(me.id);
        if (mine) inbox.push({ instanceId: r.id, nodeId: a.nodeId });
      }
    }
    return {
      selfEmployeeId: me?.id ?? null,
      canManage: canManage(context),
      connectedTriggers: connectedTriggers(),
      defs: defs.map((d) => ({
        id: d.id, name: d.name, description: d.description ?? undefined, triggerType: d.triggerType, active: d.active, version: d.version, nodes: d.nodes, edges: d.edges,
        createdBy: d.createdByUserId ? names.get(d.createdByUserId) ?? 'Former member' : 'Sabi starter', createdAt: d.createdAt, updatedAt: d.updatedAt,
      })),
      instances: visible.map((r) => ({
        id: r.id, defId: r.defId, defName: r.defName, triggerType: r.triggerType, subject: r.subject, reference: r.reference, context: r.context, isTest: r.isTest,
        initiatedBy: person(r.initiatedByEmployeeId, r.initiatedByUserId), status: r.status, version: r.version, graph: r.graph,
        active: r.active.map(({ approverIds, ...a }) => ({ ...a, approverIds, approverId: approverIds?.[0] ?? a.approverId, memberDecisions: a.memberDecisions?.map(({ approverIds: ids, ...m }) => ({ ...m, approverIds: ids, approverId: ids?.[0] })) })),
        history: events.filter((e) => e.instanceId === r.id).map((e) => ({ id: e.id, nodeId: e.nodeId, nodeLabel: e.nodeLabel, action: e.action, actorId: person(e.actorEmployeeId, e.actorUserId), comment: e.comment ?? undefined, at: e.createdAt })),
        createdAt: r.createdAt, completedAt: r.completedAt ?? undefined,
      })),
      inbox,
    };
  });
}
