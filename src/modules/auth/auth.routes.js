import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { confirmPasswordReset, getCurrentUser, getSessions, login, logout, logoutEverywhere, logoutOtherDevices, refreshAccessToken, registerPatient, requestPasswordReset, revokeDeviceSession } from './auth.controller.js';
import { loginSchema, mfaConfirmSchema, mfaEnrollSchema, mfaFactorSchema, mfaLoginSchema, passwordResetConfirmSchema, passwordResetRequestSchema, refreshTokenSchema, registerPatientSchema, sessionIdSchema } from './auth.validator.js';
import { requireTrustedOrigin } from './auth.cookie.js';
import { loginLimiter, mfaLimiter, registrationLimiter, resetConfirmLimiter, resetRequestLimiter, refreshLimiter, sensitiveLimiter } from '../../middleware/rateLimitMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { confirmTotp, enrollTotp, mfaStatus, removeMfa, replaceRecoveryCodes, stepUp, verifyMfaLogin } from './auth.mfa.controller.js';
import { requireOrganization, requirePermission, requirePlatform } from '../../middleware/accessMiddleware.js';
import { acceptMembership, inviteMembership, listManagedMemberships, organizations, platformContext, revokeMembership, switchOrganization } from '../identity/identity.controller.js';
import { inviteMembershipSchema, managedMembershipSchema, managedOrganizationSchema, membershipIdSchema, switchOrganizationSchema } from '../identity/identity.validator.js';

const router = express.Router();

router.post('/register/patient', registrationLimiter, validate(registerPatientSchema), registerPatient);
router.post('/login', loginLimiter, requireTrustedOrigin, validate(loginSchema), login);
router.post('/mfa/login/verify', mfaLimiter, requireTrustedOrigin, validate(mfaLoginSchema), verifyMfaLogin);
router.get('/mfa/status', protect, mfaStatus);
router.post('/mfa/totp/enroll', protect, sensitiveLimiter, validate(mfaEnrollSchema), enrollTotp);
router.post('/mfa/totp/confirm', protect, mfaLimiter, validate(mfaConfirmSchema), confirmTotp);
router.post('/mfa/step-up', protect, mfaLimiter, validate(mfaFactorSchema), stepUp);
router.post('/mfa/recovery/regenerate', protect, sensitiveLimiter, requireRecentMfa, replaceRecoveryCodes);
router.post('/mfa/disable', protect, sensitiveLimiter, requireRecentMfa, validate(mfaEnrollSchema), removeMfa);
router.post('/refresh', refreshLimiter, requireTrustedOrigin, validate(refreshTokenSchema), refreshAccessToken);
router.post('/logout', requireTrustedOrigin, validate(refreshTokenSchema), logout);
router.get('/sessions', protect, getSessions);
router.post('/sessions/logout-others', protect, logoutOtherDevices);
router.post('/sessions/logout-all', protect, logoutEverywhere);
router.post('/sessions/:id/revoke', protect, validate(sessionIdSchema), revokeDeviceSession);
router.post('/password-reset/request', resetRequestLimiter, validate(passwordResetRequestSchema), requestPasswordReset);
router.post('/password-reset/confirm', resetConfirmLimiter, validate(passwordResetConfirmSchema), confirmPasswordReset);
router.get('/me', protect, getCurrentUser);
router.get('/organizations', protect, organizations);
router.post('/organizations/switch', protect, validate(switchOrganizationSchema), switchOrganization);
router.post('/memberships/:id/accept', protect, validate(membershipIdSchema), acceptMembership);
router.get('/organizations/:organizationId/memberships', protect, validate(managedOrganizationSchema), requireOrganization, requirePermission('membership.read'), listManagedMemberships);
router.post('/organizations/:organizationId/memberships', protect, validate(inviteMembershipSchema), requireOrganization, requirePermission('membership.manage'), requireRecentMfa, inviteMembership);
router.post('/organizations/:organizationId/memberships/:id/revoke', protect, validate(managedMembershipSchema), requireOrganization, requirePermission('membership.manage'), requireRecentMfa, revokeMembership);
router.get('/platform-context', protect, requirePlatform, requireRecentMfa, platformContext);

router.use((err, req, res, next) => {
  console.error('Auth Module Isolated Error:', err);
  res.status(500).json({ status: 'error', message: 'Authentication service temporarily unavailable' });
});

export default router;
