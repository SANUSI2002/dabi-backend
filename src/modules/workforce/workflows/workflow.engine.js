// The approval graph, evaluated on the server. Same model as the Workflow Builder screen: a
// definition is a graph of nodes (start, approval, review, condition, parallel, notify,
// escalation, end) joined by edges with a branch (approve, reject, true, false, timeout, default).
// Pure functions only — who an approver is comes from the `resolve` callback, which the service
// builds from the organization's records (never from what the browser sends).

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : NaN);

export function evalCondition(c, ctx) {
  const left = ctx[c.field];
  const right = c.value;
  switch (c.op) {
    case 'eq': return String(left ?? '') === String(right);
    case 'ne': return String(left ?? '') !== String(right);
    case 'gt': return num(left) > num(right);
    case 'gte': return num(left) >= num(right);
    case 'lt': return num(left) < num(right);
    case 'lte': return num(left) <= num(right);
    case 'contains': return String(left ?? '').toLowerCase().includes(String(right).toLowerCase());
    case 'in': return String(right).split(',').map((s) => s.trim().toLowerCase()).includes(String(left ?? '').toLowerCase());
    default: return false;
  }
}
export function evalNode(node, ctx) {
  const list = node.conditions ?? [];
  if (list.length === 0) return true;
  return node.conditionMatch === 'any' ? list.some((c) => evalCondition(c, ctx)) : list.every((c) => evalCondition(c, ctx));
}

export const nodeById = (def, id) => def.nodes.find((n) => n.id === id);
export const startNode = (def) => def.nodes.find((n) => n.type === 'start');
export const outgoing = (def, nodeId) => def.edges.filter((e) => e.from === nodeId);
export function edgeFor(def, nodeId, branch) {
  const outs = outgoing(def, nodeId);
  return outs.find((e) => e.branch === branch) ?? outs.find((e) => e.branch === 'default') ?? outs[0];
}
/** The edge a stalled step times out along (directly, or through an escalation node), with its hours. */
export function timeoutOf(def, nodeId) {
  const edge = outgoing(def, nodeId).find((e) => e.branch === 'timeout');
  if (!edge) return null;
  const esc = nodeById(def, edge.to);
  return { hours: esc?.type === 'escalation' ? esc.afterHours ?? 48 : 48 };
}

const HUMAN = new Set(['approval', 'review', 'parallel']);

/**
 * From a node just satisfied along `branch`, walk through the automatic nodes (start, condition,
 * notify, escalation) to the next human steps or an end. `resolve(approverType, approverRef, label)`
 * returns `{ ids, label, note? }` — the employees who may decide.
 */
export function walkFrom(def, fromNodeId, branch, ctx, resolve, onAuto, now = new Date()) {
  const enteredAt = now.toISOString();
  const visited = new Set();
  const queue = [];
  const active = [];
  const edge = edgeFor(def, fromNodeId, branch);
  if (!edge) return { active: [], ended: 'approved' }; // a dead end after a decision counts as approved
  queue.push(edge.to);
  while (queue.length) {
    const nodeId = queue.shift();
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = nodeById(def, nodeId);
    if (!node) continue;
    if (node.type === 'end') return { active: [], ended: node.outcome ?? 'approved' };
    if (node.type === 'condition') {
      const pass = evalNode(node, ctx);
      onAuto?.(node, `condition ${pass ? 'true' : 'false'}`);
      const e = edgeFor(def, node.id, pass ? 'true' : 'false');
      if (!e) return { active, ended: 'approved' };
      queue.push(e.to);
      continue;
    }
    if (node.type === 'notify' || node.type === 'start') {
      if (node.type === 'notify') onAuto?.(node, node.notifyText ?? 'notification sent');
      const e = edgeFor(def, node.id, 'default');
      if (e) queue.push(e.to);
      continue;
    }
    if (node.type === 'escalation') {
      onAuto?.(node, `escalated after ${node.afterHours ?? 48}h`);
      const e = edgeFor(def, node.id, 'timeout') ?? edgeFor(def, node.id, 'default');
      if (e) queue.push(e.to);
      continue;
    }
    if (!HUMAN.has(node.type)) continue;
    if (node.type === 'parallel') {
      const memberDecisions = (node.members ?? []).map((m) => {
        const r = resolve(m.approverType, m.approverRef, m.label);
        if (r.note) onAuto?.(node, `${m.label}: ${r.note}`);
        return { approverId: r.ids[0], approverIds: r.ids, label: m.label, decision: 'pending' };
      });
      active.push({ nodeId: node.id, enteredAt, memberDecisions, approverLabel: `Parallel (${node.joinMode ?? 'all'})` });
      continue;
    }
    const r = resolve(node.approverType, node.approverRef, node.label);
    if (r.note) onAuto?.(node, r.note);
    active.push({ nodeId: node.id, approverId: r.ids[0], approverIds: r.ids, approverLabel: r.label, enteredAt });
  }
  return { active, ended: active.length === 0 ? 'approved' : undefined };
}

/** Outcome of a parallel step after a member decided, or undefined while it is still open. */
export function parallelOutcome(node, memberDecisions) {
  const decided = memberDecisions.filter((m) => m.decision !== 'pending');
  const approvals = decided.filter((m) => m.decision === 'approved').length;
  const rejections = decided.length - approvals;
  const need = node.joinMode === 'any' ? 1 : node.joinMode === 'quorum' ? node.quorum ?? memberDecisions.length : memberDecisions.length;
  if (rejections > 0 && node.joinMode !== 'any') return 'reject';
  if (approvals >= need) return 'approve';
  if (decided.length === memberDecisions.length) return 'reject';
  return undefined;
}

/** Structural checks — a definition must pass them to be activated. */
export function validateDef(def) {
  const errs = [];
  if (def.nodes.filter((n) => n.type === 'start').length !== 1) errs.push('Exactly one Start node is required.');
  if (!def.nodes.some((n) => n.type === 'end')) errs.push('At least one End node is required.');
  const ids = new Set(def.nodes.map((n) => n.id));
  for (const e of def.edges) if (!ids.has(e.from) || !ids.has(e.to)) errs.push('A connection points at a step that does not exist.');
  for (const n of def.nodes) {
    if (n.type === 'start' && outgoing(def, n.id).length === 0) errs.push('Start node has no outgoing connection.');
    if ((n.type === 'approval' || n.type === 'review') && !n.approverType) errs.push(`"${n.label}" has no approver set.`);
    if (n.type === 'parallel' && !(n.members ?? []).length) errs.push(`Parallel "${n.label}" has no members.`);
    if (n.type === 'condition') {
      const outs = outgoing(def, n.id);
      if (!outs.some((e) => e.branch === 'true') || !outs.some((e) => e.branch === 'false')) errs.push(`Condition "${n.label}" needs both a true and a false path.`);
    }
    if (n.type === 'escalation' && !n.afterHours) errs.push(`Escalation "${n.label}" has no timeout hours.`);
  }
  const start = startNode(def);
  if (start) {
    const seen = new Set();
    const stack = [start.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of outgoing(def, id)) stack.push(e.to);
    }
    for (const n of def.nodes) if (!seen.has(n.id)) errs.push(`"${n.label}" is not reachable from Start.`);
  }
  return [...new Set(errs)];
}
