import express from 'express'; import { protect } from '../../middleware/authMiddleware.js'; import { validate } from '../../middleware/validateMiddleware.js'; import * as V from './professionals.validator.js'; import * as C from './professionals.controller.js';
const router = express.Router();
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
router.post('/register', validate(V.registerSchema), C.register);
router.use(protect); router.get('/me', C.mine);
// One gate for every /admin route (the list and each decision): super-admin, then recent MFA.
router.use('/admin', C.admin, requireRecentMfa);
router.get('/admin', validate(V.listSchema), C.list);
router.post('/admin/:id/approve', validate(V.decisionSchema), C.approve); router.post('/admin/:id/reject', validate(V.decisionSchema), C.reject); router.post('/admin/:id/suspend', validate(V.decisionSchema), C.suspend); router.post('/admin/:id/reactivate', validate(V.decisionSchema), C.reactivate);
router.use((err, req, res, next) => res.status(500).json({ status: 'error', message: 'Professionals module temporarily unavailable' })); export default router;
