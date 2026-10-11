// /api/v1/command-centre — the platform operations API. Platform staff only; every sub-router
// declares the permissions each route needs (see cc.common.js and migration
// 20261022090000_command_centre_foundations for the roles).
import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { requirePlatform } from '../../middleware/accessMiddleware.js';
import { auditRoutes, meRoutes, searchRoutes } from './audit.routes.js';
import { caseRoutes } from './cases.routes.js';
import { financeRoutes } from './finance.routes.js';
import { opsRoutes } from './ops.routes.js';
import { deliveryRoutes, orderRoutes } from './orders.routes.js';
import { overviewRoutes } from './overview.routes.js';
import { pharmacyRoutes } from './pharmacy.routes.js';
import { consultationRoutes, providerRoutes } from './oversight.routes.js';
import { emergencyRoutes, patientRoutes } from './patients.routes.js';
import { platformAdminRoutes } from './platform.routes.js';
import { pricingRoutes } from './pricing.routes.js';
import { productRoutes } from './products.routes.js';

const router = express.Router();
router.use(protect, requirePlatform);
// Platform data must never be cached by browsers or shared proxies.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.use('/me', meRoutes);
router.use('/overview', overviewRoutes);
router.use('/search', searchRoutes);
router.use('/patients', patientRoutes);
router.use('/emergency-access', emergencyRoutes);
router.use('/orders', orderRoutes);
router.use('/deliveries', deliveryRoutes);
router.use('/consultations', consultationRoutes);
router.use('/providers', providerRoutes);
router.use('/finance', financeRoutes);
router.use('/cases', caseRoutes);
router.use('/ops', opsRoutes);
router.use('/audit', auditRoutes);
router.use('/pricing', pricingRoutes);
router.use('/', productRoutes);
router.use('/', platformAdminRoutes);
router.use('/pharmacy-exceptions', pharmacyRoutes);

export default router;
