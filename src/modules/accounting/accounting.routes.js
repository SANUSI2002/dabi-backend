// Accounting API root: /api/v1/accounting (general ledger; receivables, payables and the rest follow),
// and /api/v1/accounting/portal for customers' and suppliers' self-service links.
//
// Same chain and tenancy as the EMR and Workforce APIs (RLS through withTenant, the same audit trail),
// gated by the organization's 'accounting' product entitlement so Accounting can be sold on its own:
//   requestContext → protect (JWT) → org param → requireOrganization → accountingTenant → tenantRateLimit.
// Permissions (acct.view / acct.post / acct.approve / acct.control) are checked per action by the services.
import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { requireOrganization } from '../../middleware/accessMiddleware.js';
import { requestContext } from '../emr/core/logging.js';
import { accountingTenant } from '../emr/core/context.js';
import { tenantRateLimit } from '../emr/core/rateLimit.js';
import { EmrError, emrErrorHandler } from '../emr/core/errors.js';
import { handle, validateEmr } from '../emr/core/validate.js';
import { send } from '../emr/core/http.js';
import { accountingAuditEvents } from './audit.js';
import { applyLandedCost, inventoryOverview, receiveStock } from './inventory.js';
import { ledgerRoutes } from './ledger/ledger.routes.js';
import { receivableRoutes, settingsRoutes } from './receivables/receivables.routes.js';
import { approvalRuleRoutes, payableRoutes } from './payables/payables.routes.js';
import { bankingRoutes, expenseRoutes } from './banking/banking.routes.js';
import { assetRoutes, planningRoutes } from './assets/assets.routes.js';
import { prefsRoutes, projectRoutes } from './projects/projects.routes.js';
import { integrationRoutes } from './integrations/integrations.routes.js';
import { attachmentRoutes } from './attachments/attachments.routes.js';
import { portalLinkRoutes, publicPortalRoutes } from './portal/portal.routes.js';
import { moduleGate } from '../org-config/modules.service.js';

const router = express.Router();
router.use(requestContext);

const tenant = express.Router({ mergeParams: true });
tenant.use(moduleGate('accounting')); // a module the organization switched off is refused
tenant.use('/ledger', ledgerRoutes);
tenant.use('/settings', settingsRoutes);
tenant.use('/receivables', receivableRoutes);
tenant.use('/payables', payableRoutes);
tenant.use('/approval-rules', approvalRuleRoutes);
tenant.use('/banking', bankingRoutes);
tenant.use('/expenses', expenseRoutes);
tenant.use('/fixed-assets', assetRoutes);
tenant.use('/planning', planningRoutes);
tenant.use('/projects', projectRoutes);
tenant.use('/notification-prefs', prefsRoutes);
tenant.use('/integrations', integrationRoutes);
tenant.use('/attachments', attachmentRoutes);
tenant.use('/portal-links', portalLinkRoutes);
tenant.get('/inventory', validateEmr(z.object({ params: z.object({ organizationId: z.uuid() }).strict(), query: z.object({}).strict() })),
  handle(async (req, res) => send(res, await inventoryOverview(req.emr))));
tenant.post('/inventory/receipts', validateEmr(z.object({
  params: z.object({ organizationId: z.uuid() }).strict(), query: z.object({}).strict(),
  body: z.object({
    itemId: z.uuid(), locationId: z.uuid().optional(), qty: z.number().int().positive().max(10_000_000), unitCostMinor: z.number().int().min(0).max(1_000_000_000_000), fundingAccount: z.number().int().min(1000).max(9999).optional(),
    batchNumber: z.string().trim().min(1).max(60).optional(), expiryDate: z.iso.date().optional(), reference: z.string().trim().min(1).max(80).optional(), note: z.string().trim().min(1).max(500).optional(),
  }).strict(),
})), handle(async (req, res) => send(res, await receiveStock(req.emr, req.body), 201)));
tenant.post('/inventory/landed-costs', validateEmr(z.object({
  params: z.object({ organizationId: z.uuid() }).strict(), query: z.object({}).strict(),
  body: z.object({
    id: z.uuid().optional(), date: z.iso.date(), description: z.string().trim().min(1).max(300), reference: z.string().trim().min(1).max(100).optional(),
    creditAccount: z.number().int().min(1000).max(9999), allocations: z.array(z.object({ itemId: z.uuid(), amount: z.number().positive().max(1e11) }).strict()).min(1).max(100),
  }).strict(),
})), handle(async (req, res) => send(res, await applyLandedCost(req.emr, req.body), 201)));
tenant.get('/audit-events', validateEmr(z.object({ params: z.object({ organizationId: z.uuid() }).strict(), query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).strict() })),
  handle(async (req, res) => send(res, await accountingAuditEvents(req.emr, req.query))));

// the customer and supplier portal: no account, the link's token is the credential (see portal.routes.js)
router.use('/portal', publicPortalRoutes);
router.use('/organizations/:organizationId', protect, validateEmr(z.object({ params: z.object({ organizationId: z.uuid() }) })), requireOrganization, accountingTenant, tenantRateLimit, tenant);
router.use((req, res, next) => next(new EmrError('NOT_FOUND')));
router.use(emrErrorHandler);

export default router;
