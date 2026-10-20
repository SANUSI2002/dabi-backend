// Workforce API root: /api/v1/workforce (people & organization, time & attendance, HR).
//
// Same chain and tenancy as the EMR API (RLS through withTenant, the same audit trail), but gated by
// the organization's 'workforce' product entitlement, so Workforce can be sold with or without the EMR:
//   requestContext → protect (JWT) → org param shape → requireOrganization → workforceTenant →
//   tenantRateLimit → module router → error handler.
import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { requireOrganization } from '../../middleware/accessMiddleware.js';
import { requestContext } from '../emr/core/logging.js';
import { workforceTenant } from '../emr/core/context.js';
import { tenantRateLimit } from '../emr/core/rateLimit.js';
import { EmrError, emrErrorHandler } from '../emr/core/errors.js';
import { validateEmr } from '../emr/core/validate.js';
import { peopleRoutes } from './people/people.routes.js';
import { timeRoutes } from './time/time.routes.js';
import { workflowRoutes } from './workflows/workflows.routes.js';
import { hiringRoutes } from './hiring/hiring.routes.js';
import { careerRoutes } from './careers/careers.routes.js';
import { payrollRoutes } from './payroll/payroll.routes.js';

const router = express.Router();
router.use(requestContext);

const tenant = express.Router({ mergeParams: true });
tenant.use('/people', peopleRoutes);
tenant.use('/time', timeRoutes);
tenant.use('/workflows', workflowRoutes);
tenant.use('/hiring', hiringRoutes);
tenant.use('/careers', careerRoutes);
tenant.use('/payroll', payrollRoutes);

router.use(
  '/organizations/:organizationId',
  protect,
  validateEmr(z.object({ params: z.object({ organizationId: z.uuid() }) })),
  requireOrganization,
  workforceTenant,
  tenantRateLimit,
  tenant,
);

router.use((req, res, next) => next(new EmrError('NOT_FOUND')));
router.use(emrErrorHandler);

export default router;
