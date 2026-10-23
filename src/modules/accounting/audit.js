// The Accounting slice of the organization's audit trail (GET /audit-events): changes to the books and
// their subledgers only — never clinical or HR events. Field names only, never values.
import { withTenant } from '../emr/core/db.js';
import { recordAudit } from '../emr/core/audit.js';
import { memberRoleMap } from '../emr/core/membership.js';
import { userNameMap } from '../emr/core/people.js';
import { requireAcct } from './ledger/ledger.service.js';

// resource type → the Audit Trail screen's module filter
const MODULE = {
  journal_entry: 'journal', recurring_journal: 'journal', fiscal_year: 'journal', ledger: 'journal', depreciation_run: 'fixed-assets',
  customer: 'invoices', invoice: 'invoices', estimate: 'invoices', sales_order: 'invoices', delayed_charge: 'invoices', revenue_schedule: 'invoices',
  receipt: 'receipts', sales_receipt: 'receipts', refund_receipt: 'receipts', credit_note: 'credit-notes',
  vendor: 'bills', purchase_requisition: 'bills', purchase_order: 'bills', bill: 'bills', vendor_credit: 'bills', vendor_payment: 'vendor-payments',
  expense_claim: 'expenses', bank_account: 'banking', bank_reconciliation: 'banking', bank_rule: 'banking', statement_line: 'banking',
  fixed_asset: 'fixed-assets', tax_rate: 'tax', tax_return: 'tax', budget: 'budgets', cost_centre: 'budgets',
  project: 'projects', account: 'coa', branch: 'coa', consolidation_group: 'coa', accounting_settings: 'settings', integration: 'settings', approval_rule: 'approvals',
};

export async function accountingAuditEvents(context, { limit = 200 } = {}) {
  requireAcct(context, 'acct.view');
  const result = await withTenant(context, async (tx) => {
    const rows = await tx.emrAuditEvent.findMany({ where: { resourceType: { in: Object.keys(MODULE) } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    const names = await userNameMap(tx, rows.map((e) => e.actorUserId));
    await recordAudit(tx, context, { action: 'audit.viewed', resourceType: 'accounting_audit' });
    return rows.map((e) => ({ ...e, actorName: e.actorUserId ? names.get(e.actorUserId) ?? null : null }));
  });
  const roles = await memberRoleMap(context.organizationId, result.map((e) => e.actorUserId));
  return {
    items: result.map((e) => ({
      id: e.id, at: e.createdAt, action: e.action, module: MODULE[e.resourceType], resourceType: e.resourceType, resourceId: e.resourceId, changedFields: e.changedFields,
      actorName: e.actorName, actorRoles: e.actorUserId ? roles.get(e.actorUserId) ?? [] : [],
    })),
  };
}
