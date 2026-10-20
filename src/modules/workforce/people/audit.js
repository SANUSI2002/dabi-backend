// The HR slice of the organization's audit trail (GET /people/audit-events): changes to Workforce
// records only — never clinical events. Payroll entries are shown only to payroll staff.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { memberRoleMap } from '../../emr/core/membership.js';
import { userNameMap } from '../../emr/core/people.js';

const WORKFORCE = [
  'employee', 'employee_document', 'disciplinary_action', 'department', 'company', 'job_position', 'job_role', 'policy', 'hr', 'hr_settings',
  'time_block', 'schedule', 'time_policy', 'time_settings', 'period', 'timesheet', 'holiday', 'work_container', 'work_task', 'time',
  'workflow_def', 'workflow_instance', 'requisition', 'candidate', 'interview', 'talent', 'vacancy', 'onboarding', 'offboarding',
  'review_period', 'objective', 'employee_objective', 'feedback', 'meeting', 'promotion', 'branch_transfer',
  'asset_category', 'company_asset', 'asset_request', 'ticket', 'faq', 'query',
];
const PAYROLL = ['salary_structure', 'payroll_batch', 'payslip', 'contract', 'loan', 'loan_letter', 'loan_tier', 'reimbursement'];

export async function hrAuditEvents(context, { limit = 200 } = {}) {
  const types = [...WORKFORCE, ...(context.permissions.includes('payroll.read') ? PAYROLL : [])];
  const result = await withTenant(context, async (tx) => {
    const rows = await tx.emrAuditEvent.findMany({ where: { resourceType: { in: types } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    const names = await userNameMap(tx, rows.map((e) => e.actorUserId));
    await recordAudit(tx, context, { action: 'audit.viewed', resourceType: 'hr_audit' });
    return rows.map((e) => ({ ...e, actorName: e.actorUserId ? names.get(e.actorUserId) ?? null : null }));
  });
  const roles = await memberRoleMap(context.organizationId, result.map((e) => e.actorUserId));
  return {
    items: result.map((e) => ({
      id: e.id, at: e.createdAt, action: e.action, resourceType: e.resourceType, resourceId: e.resourceId, changedFields: e.changedFields,
      actorName: e.actorName, actorRoles: e.actorUserId ? roles.get(e.actorUserId) ?? [] : [],
    })),
  };
}
