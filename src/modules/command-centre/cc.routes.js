// /api/v1/command-centre — the platform operations API. Platform staff only; every sub-router
// declares the permissions each route needs (see cc.common.js and migration
// 20261022090000_command_centre_foundations for the roles).
import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { requirePlatform } from '../../middleware/accessMiddleware.js';
import { pricingRoutes } from './pricing.routes.js';

const router = express.Router();
router.use(protect, requirePlatform);
// Platform data must never be cached by browsers or shared proxies.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.use('/pricing', pricingRoutes);

export default router;
