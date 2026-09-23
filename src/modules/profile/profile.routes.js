import express from 'express';
import {
  getProfile,
  updateProfile,
  updateSecurity,
  changePassword,
  deleteAccount,
  getEmergencySummary,
} from './profile.controller.js';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import {
  updateProfileSchema,
  updateSecuritySchema,
  changePasswordSchema,
  deleteAccountSchema,
} from './profile.validator.js';
import { sensitiveLimiter } from '../../middleware/rateLimitMiddleware.js';
import { requireRecentMfaIfEnrolled } from '../../middleware/mfaMiddleware.js';

const router = express.Router();

// Every profile route requires a valid JWT.
router.use(protect);

router.get('/', getProfile);
router.get('/emergency-summary', getEmergencySummary);
router.put('/update', sensitiveLimiter, validate(updateProfileSchema), (req, res, next) => (req.body.email !== undefined || req.body.phone_number !== undefined) ? requireRecentMfaIfEnrolled(req, res, next) : next(), updateProfile);

// Security settings.
router.put('/security', sensitiveLimiter, validate(updateSecuritySchema), updateSecurity);
router.put('/security/change-password', sensitiveLimiter, validate(changePasswordSchema), requireRecentMfaIfEnrolled, changePassword);

// Danger zone — requires the body to contain { "confirmation": "DELETE" }.
router.delete('/delete-account', sensitiveLimiter, validate(deleteAccountSchema), requireRecentMfaIfEnrolled, deleteAccount);

// Module-scoped error boundary. MUST come AFTER the routes: Express only forwards
// errors to a 4-arg middleware declared after the handler that threw, so placing
// it first (as before) meant it never actually caught anything.
router.use((err, req, res, next) => {
  console.error('Profile Module Isolated Error:', err);
  res.status(500).json({ status: 'error', message: 'Profile module temporarily unavailable' });
});

export default router;
