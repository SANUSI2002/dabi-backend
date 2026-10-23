// Accounting approvals: the organization's approval rules (by document type and amount band) build an
// approval for a document; each step names a finance role. A step is decided by someone holding that
// role's permission (Accountant → acct.post, Approver → acct.approve, Finance Controller → acct.control,
// who may also clear any step) — never by the person who submitted the document.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { EmrError } from '../../emr/core/errors.js';
import { ensureBooks, requireAcct, round2 } from '../ledger/ledger.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const ROLE_PERMISSION = { Accountant: 'acct.post', Approver: 'acct.approve', 'Finance Controller': 'acct.control' };
export const NOT_REQUIRED = { status: 'Not Required', currentLevel: 0, steps: [] };

export async function buildApproval(tx, context, docType, amount) {
  await ensureBooks(tx, context);
  const rules = (await tx.acctApprovalRule.findMany({ where: { ...org(context), docType, active: true }, orderBy: { level: 'asc' } }))
    .filter((r) => round2(amount) >= Number(r.minAmount) && (r.maxAmount === null || round2(amount) < Number(r.maxAmount)));
  if (!rules.length) return NOT_REQUIRED;
  return { status: 'Pending', currentLevel: rules[0].level, submittedByUserId: context.userId, submittedAt: new Date().toISOString(), steps: rules.map((r) => ({ level: r.level, approverRole: r.approverRole, decision: 'Pending' })) };
}

/** Whether the signed-in person may decide the approval's current step. */
export function mayDecide(context, approval) {
  if (approval?.status !== 'Pending' || approval.submittedByUserId === context.userId) return false;
  const step = approval.steps.find((s) => s.level === approval.currentLevel);
  return !!step && (context.permissions.includes('acct.control') || context.permissions.includes(ROLE_PERMISSION[step.approverRole]));
}

/** Decides the current step; returns the updated approval. */
export function decideApproval(context, approval, decision, comment) {
  if (approval?.status !== 'Pending') throw new EmrError('INVALID_STATE', { message: 'Nothing is waiting for approval on this document.' });
  if (approval.submittedByUserId === context.userId) throw new EmrError('OWN_REQUEST');
  if (!mayDecide(context, approval)) throw new EmrError('PERMISSION_DENIED', { message: 'This approval step is for another finance role.' });
  const steps = approval.steps.map((s) => (s.level === approval.currentLevel ? { ...s, decision, decidedByUserId: context.userId, decidedAt: new Date().toISOString(), ...(comment ? { comment } : {}) } : s));
  if (decision === 'Rejected') return { ...approval, steps, status: 'Rejected' };
  const remaining = steps.filter((s) => s.decision === 'Pending').sort((a, b) => a.level - b.level);
  return remaining.length ? { ...approval, steps, currentLevel: remaining[0].level } : { ...approval, steps, status: 'Approved' };
}

/** The approval as the screens show it: names instead of user ids, and whether it is yours to decide. */
export function presentApproval(context, approval, names) {
  if (!approval) return { ...NOT_REQUIRED };
  const { submittedByUserId, ...rest } = approval;
  return {
    ...rest, submittedBy: submittedByUserId ? names.get(submittedByUserId) ?? 'Former member' : undefined, submittedByMe: submittedByUserId === context.userId, decidableByMe: mayDecide(context, approval),
    steps: approval.steps.map(({ decidedByUserId, ...s }) => ({ ...s, ...(decidedByUserId ? { decidedBy: names.get(decidedByUserId) ?? 'Former member' } : {}) })),
  };
}
export const approvalUserIds = (approval) => [approval?.submittedByUserId, ...(approval?.steps ?? []).map((s) => s.decidedByUserId)].filter(Boolean);

// ---- the rules themselves (Settings → Approval Rules) -----------------------------------------------
export async function addRule(context, input) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const r = await tx.acctApprovalRule.create({ data: { ...(input.id ? { id: input.id } : {}), ...org(context), docType: input.docType, minAmount: input.minAmount, maxAmount: input.maxAmount, approverRole: input.approverRole, level: input.level } });
    await recordAudit(tx, context, { action: 'approval_rule.added', resourceType: 'approval_rule', resourceId: r.id });
    return { id: r.id };
  });
}
export async function updateRule(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const { count } = await tx.acctApprovalRule.updateMany({ where: { ...org(context), id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
    if (!count) throw (await tx.acctApprovalRule.findFirst({ where: { ...org(context), id } })) ? new EmrError('VERSION_CONFLICT') : new EmrError('HR_RECORD_NOT_FOUND');
    await recordAudit(tx, context, { action: 'approval_rule.updated', resourceType: 'approval_rule', resourceId: id, changedFields: Object.keys(data) });
    return { id };
  });
}
