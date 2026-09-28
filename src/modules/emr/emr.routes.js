// EMR API root: /api/v1/emr
//
// Every tenant route passes the same chain, in this order:
//   requestContext → protect (JWT) → org param shape → requireOrganization (active membership,
//   tenant from the token) → emrTenant (URL tenant == token tenant, EMR entitlement, feature
//   switch) → tenantRateLimit → module router → emrErrorHandler.
// New clinical modules are added by mounting their router on `tenant` below.
import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { requireOrganization, requirePlatform } from '../../middleware/accessMiddleware.js';
import { requestContext, metricsSnapshot } from './core/logging.js';
import { emrTenant } from './core/context.js';
import { tenantRateLimit } from './core/rateLimit.js';
import { EmrError, emrErrorHandler } from './core/errors.js';
import { validateEmr } from './core/validate.js';
import patientRoutes from './patients/patients.routes.js';
import encounterRoutes from './encounters/encounters.routes.js';
import webhookRoutes from './webhooks/webhooks.routes.js';
import auditRoutes from './audit/audit.routes.js';

const router = express.Router();
router.use(requestContext);

// Platform operators only: per-tenant request/error/latency counters (no PHI).
router.get('/internal/metrics', protect, requirePlatform, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { tenants: metricsSnapshot() } });
});

const tenant = express.Router({ mergeParams: true });
tenant.use('/patients', patientRoutes);
tenant.use('/encounters', encounterRoutes);
tenant.use('/webhooks', webhookRoutes);
tenant.use('/audit-events', auditRoutes);

router.use(
  '/organizations/:organizationId',
  protect,
  validateEmr(z.object({ params: z.object({ organizationId: z.uuid() }) })),
  requireOrganization,
  emrTenant,
  tenantRateLimit,
  tenant,
);

router.use((req, res, next) => next(new EmrError('NOT_FOUND')));
router.use(emrErrorHandler);

export default router;
