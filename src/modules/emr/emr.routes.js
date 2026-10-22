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
import { staffRoutes } from './staff/staff.routes.js';
import { pharmacyRoutes, encounterPrescriptionRoutes, patientPharmacyRoutes } from './pharmacy/pharmacy.routes.js';
import { wardRoutes, bedRoutes, encounterAdmissionRoutes, admissionRoutes } from './admissions/admissions.routes.js';
import { admissionWardRoundRoutes, wardRoundRoutes } from './wardrounds/wardrounds.routes.js';
import { scadaIngestRoutes, scadaRoutes } from './scada/scada.routes.js';
import { billingRoutes } from './billing/billing.routes.js';
import { queueRoutes } from './queue/queue.routes.js';
import { patientRecordRoutes } from './records/records.routes.js';
import { dashboardRoutes } from './dashboard/dashboard.routes.js';
import { appointmentRoutes } from './appointments/appointments.routes.js';
import { imagingRoutes } from './radiology/radiology.routes.js';
import { procedureRoutes } from './procedures/procedures.routes.js';
import { catalogRoutes } from './catalogs/catalogs.routes.js';
import { equipmentRoutes } from './assets/assets.routes.js';
import { storeRoutes } from './stores/stores.routes.js';
import { reportRoutes } from './reports/reports.routes.js';
import { outreachRoutes } from './outreach/outreach.routes.js';
import { transferRoutes } from './transfers/transfers.routes.js';
import { referralRoutes } from './referrals/referrals.routes.js';
import { programmeRoutes } from './programmes/programmes.routes.js';
import { nutritionRoutes } from './nutrition/nutrition.routes.js';
import { familyPlanningRoutes } from './family-planning/family-planning.routes.js';
import { immunizationRoutes } from './immunizations/immunizations.routes.js';
import { surveillanceRoutes } from './surveillance/surveillance.routes.js';
import { postnatalRoutes } from './postnatal/postnatal.routes.js';
import { antenatalRoutes } from './antenatal/antenatal.routes.js';
import { birthRoutes, deliveryRoutes } from './deliveries/deliveries.routes.js';
import { tenantRuntimeRoutes } from '../command-centre/runtime.routes.js';
import { moduleGate } from '../org-config/modules.service.js';

const router = express.Router();
router.use(requestContext);

// Platform operators only: per-tenant request/error/latency counters (no PHI).
router.get('/internal/metrics', protect, requirePlatform, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { tenants: metricsSnapshot() } });
});

const tenant = express.Router({ mergeParams: true });
tenant.use(moduleGate('emr')); // a module the organization switched off is refused
tenant.use('/runtime', tenantRuntimeRoutes);
tenant.use('/patients', patientRoutes);
tenant.use('/patients/:patientId', patientPharmacyRoutes);
tenant.use('/patients/:patientId', patientRecordRoutes);
tenant.use('/encounters', encounterRoutes);
tenant.use('/encounters/:encounterId/lab-orders', encounterLabRoutes);
tenant.use('/lab', labRoutes);
tenant.use('/encounters/:encounterId/prescriptions', encounterPrescriptionRoutes);
tenant.use('/pharmacy', pharmacyRoutes);
tenant.use('/encounters/:encounterId/admission', encounterAdmissionRoutes);
tenant.use('/wards', wardRoutes);
tenant.use('/beds', bedRoutes);
tenant.use('/admissions/:admissionId/ward-rounds', admissionWardRoundRoutes);
tenant.use('/admissions', admissionRoutes);
tenant.use('/ward-rounds', wardRoundRoutes);
tenant.use('/billing', billingRoutes);
tenant.use('/queue', queueRoutes);
tenant.use('/dashboard', dashboardRoutes);
tenant.use('/appointments', appointmentRoutes);
tenant.use('/imaging', imagingRoutes);
tenant.use('/procedures', procedureRoutes);
tenant.use('/catalogs', catalogRoutes);
tenant.use('/equipment', equipmentRoutes);
tenant.use('/scada', scadaRoutes);
tenant.use('/stores', storeRoutes);
tenant.use('/reports', reportRoutes);
tenant.use('/outreach', outreachRoutes);
tenant.use('/transfers', transferRoutes);
tenant.use('/referrals', referralRoutes);
tenant.use('/programmes', programmeRoutes);
tenant.use('/nutrition', nutritionRoutes);
tenant.use('/family-planning', familyPlanningRoutes);
tenant.use('/surveillance', surveillanceRoutes);
tenant.use('/immunizations', immunizationRoutes);
tenant.use('/postnatal', postnatalRoutes);
tenant.use('/antenatal', antenatalRoutes);
tenant.use('/deliveries', deliveryRoutes);
tenant.use('/births', birthRoutes);
tenant.use('/staff', staffRoutes);
tenant.use('/webhooks', webhookRoutes);
tenant.use('/audit-events', auditRoutes);
tenant.use('/telehealth/designation', telehealthRoutes);

// Devices report with their own key, not a staff sign-in (see scada.routes.js).
router.use('/scada/ingest', scadaIngestRoutes);

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
