// Accounting API root: /api/v1/accounting (general ledger; receivables, payables and the rest follow).
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
import { validateEmr } from '../emr/core/validate.js';
import { ledgerRoutes } from './ledger/ledger.routes.js';
import { receivableRoutes, settingsRoutes } from './receivables/receivables.routes.js';

const router = express.Router();
router.use(requestContext);

const tenant = express.Router({ mergeParams: true });
tenant.use('/ledger', ledgerRoutes);
tenant.use('/settings', settingsRoutes);
tenant.use('/receivables', receivableRoutes);

router.use('/organizations/:organizationId', protect, validateEmr(z.object({ params: z.object({ organizationId: z.uuid() }) })), requireOrganization, accountingTenant, tenantRateLimit, tenant);
router.use((req, res, next) => next(new EmrError('NOT_FOUND')));
router.use(emrErrorHandler);

export default router;
