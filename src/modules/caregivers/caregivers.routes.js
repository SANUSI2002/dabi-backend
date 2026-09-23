import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { createLimiter } from '../../middleware/rateLimitMiddleware.js';
import * as controller from './caregivers.controller.js';
import * as schema from './caregivers.validator.js';

const router = express.Router();
// IP bound so nested email changes cannot evade the registration limit.
const registrationLimiter = createLimiter({ kind: 'caregiver-registration', max: 5 });
router.post('/auth/register/caregiver', registrationLimiter, validate(schema.registration), controller.register);
router.get('/caregivers/me', protect, validate(schema.me), controller.me);
router.use(controller.errorHandler);
export default router;
