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
import telehealthRoutes from './telehealth/telehealth.routes.js';
import { labRoutes, encounterLabRoutes } from './lab/lab.routes.js';
import { pharmacyRoutes, encounterPrescriptionRoutes, patientPharmacyRoutes } from './pharmacy/pharmacy.routes.js';
import { wardRoutes, bedRoutes, encounterAdmissionRoutes, admissionRoutes } from './admissions/admissions.routes.js';
import { billingRoutes } from './billing/billing.routes.js';
import { queueRoutes } from './queue/queue.routes.js';

const router = express.Router();
router.use(requestContext);

// Platform operators only: per-tenant request/error/latency counters (no PHI).
router.get('/internal/metrics', protect, requirePlatform, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { tenants: metricsSnapshot() } });
});

const tenant = express.Router({ mergeParams: true });
tenant.use('/patients', patientRoutes);
tenant.use('/patients/:patientId', patientPharmacyRoutes);
tenant.use('/encounters', encounterRoutes);
tenant.use('/encounters/:encounterId/lab-orders', encounterLabRoutes);
tenant.use('/lab', labRoutes);
tenant.use('/encounters/:encounterId/prescriptions', encounterPrescriptionRoutes);
tenant.use('/pharmacy', pharmacyRoutes);
tenant.use('/encounters/:encounterId/admission', encounterAdmissionRoutes);
tenant.use('/wards', wardRoutes);
tenant.use('/beds', bedRoutes);
tenant.use('/admissions', admissionRoutes);
tenant.use('/billing', billingRoutes);
tenant.use('/queue', queueRoutes);
tenant.use('/webhooks', webhookRoutes);
tenant.use('/audit-events', auditRoutes);
tenant.use('/telehealth/designation', telehealthRoutes);

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
