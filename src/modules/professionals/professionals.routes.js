import express from 'express'; import { protect } from '../../middleware/authMiddleware.js'; import { validate } from '../../middleware/validateMiddleware.js'; import * as V from './professionals.validator.js'; import * as C from './professionals.controller.js';
const router = express.Router();
router.post('/register', validate(V.registerSchema), C.register);
router.use(protect); router.get('/me', C.mine); router.get('/admin', C.admin, validate(V.listSchema), C.list);
router.post('/admin/:id/approve', C.admin, validate(V.decisionSchema), C.approve); router.post('/admin/:id/reject', C.admin, validate(V.decisionSchema), C.reject); router.post('/admin/:id/suspend', C.admin, validate(V.decisionSchema), C.suspend); router.post('/admin/:id/reactivate', C.admin, validate(V.decisionSchema), C.reactivate);
router.use((err, req, res, next) => res.status(500).json({ status: 'error', message: 'Professionals module temporarily unavailable' })); export default router;
