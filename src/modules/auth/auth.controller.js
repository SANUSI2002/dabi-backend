import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import * as AuthModel from './auth.model.js';
import { generateAccessToken } from './auth.token.js';
import { browserRequest, clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './auth.cookie.js';
import { activeSession, createSession, listSessions, revokeSession, revokeUserSessions, rotateRefreshToken, sessionIdForRefresh, userIdForRefresh } from './auth.session.js';
import { sendPasswordResetEmail } from './auth.email.js';
import { activeMembershipFor, membershipsFor } from '../identity/identity.service.js';
import { beginLoginChallenge, hasActiveMfa } from './auth.mfa.js';

const toUserResponse = (user) => ({
  id: user.id,
  email: user.email,
  patientId: user.patientId,
  profile: user.profile,
  roles: user.roles.map(({ role }) => role),
  ...(user.caregiverProfile ? { caregiverProfile: user.caregiverProfile } : {}),
});

export const registerPatient = async (req, res, next) => {
  try {
    const user = await AuthModel.createPatient(req.body);
    return res.status(201).json({ status: 'success', message: 'Patient registered successfully', user: toUserResponse(user) });
  } catch (error) {
    if (error?.code === 'P2002') return res.status(409).json({ status: 'error', message: 'User with this email already exists' });
    return next(error);
  }
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await AuthModel.findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password)) || (user.accountStatus && user.accountStatus !== 'ACTIVE')) {
      return res.status(401).json({ status: 'error', message: 'Invalid email or password' });
    }
    if (await hasActiveMfa(user.id)) {
      const challengeToken = await beginLoginChallenge(user.id);
      res.set('Cache-Control', 'no-store');
      return res.status(202).json({ status: 'mfa_required', challengeToken, methods: ['totp', 'recovery_code'] });
    }
    const { session, refreshToken } = await createSession(user, req.get('user-agent') || '');
    const accessToken = generateAccessToken(user, { sessionId: session.id });
    if (browserRequest(req)) setRefreshCookie(res, refreshToken);
    return res.status(200).json({ status: 'success', message: 'Login successful', accessToken, ...(!browserRequest(req) ? { refreshToken } : {}), user: toUserResponse(user) });
  } catch (error) {
    return next(error);
  }
};

export const refreshAccessToken = async (req, res, next) => {
  try {
    const refreshToken = readRefreshCookie(req) || req.body.refreshToken;
    const { organizationId } = req.body;
    if (organizationId) {
      const requestedUserId = await userIdForRefresh(refreshToken);
      if (!requestedUserId) return res.status(401).json({ status: 'error', message: 'Invalid or revoked refresh token' });
      try { await activeMembershipFor(requestedUserId, organizationId); }
      catch { return res.status(403).json({ status: 'error', message: 'Organization access denied' }); }
    }
    const rotated = await rotateRefreshToken(refreshToken);
    const user = await AuthModel.findUserById(rotated.userId);
    if (!user || (user.accountStatus && user.accountStatus !== 'ACTIVE')) {
      await revokeSession(rotated.sessionId);
      return res.status(401).json({ status: 'error', message: 'Invalid or revoked refresh token' });
    }
    if (browserRequest(req) || readRefreshCookie(req)) setRefreshCookie(res, rotated.refreshToken);
    return res.status(200).json({ status: 'success', message: 'Access token refreshed successfully', accessToken: generateAccessToken(user, { sessionId: rotated.sessionId, organizationId }), ...(!browserRequest(req) && !readRefreshCookie(req) ? { refreshToken: rotated.refreshToken } : {}) });
  } catch (error) {
    if (error?.code === 'SESSION_INVALID' || error?.code === 'SESSION_REPLAY') return res.status(401).json({ status: 'error', message: 'Invalid or revoked refresh token' });
    return next(error);
  }
};

export const logout = async (req, res, next) => {
  try {
    const refreshToken = readRefreshCookie(req) || req.body.refreshToken;
    const sessionId = await sessionIdForRefresh(refreshToken);
    if (sessionId) await revokeSession(sessionId);
    clearRefreshCookie(res);
    return res.status(200).json({ status: 'success', message: 'Logged out successfully' });
  } catch (error) {
    return next(error);
  }
};

export const getSessions = async (req, res, next) => {
  try {
    const sessions = await listSessions(req.user.id);
    return res.json({ status: 'success', sessions: sessions.map((session) => ({ ...session, current: session.id === req.user.sessionId })) });
  } catch (error) { return next(error); }
};

export const revokeDeviceSession = async (req, res, next) => {
  try {
    const session = await activeSession(req.params.id, req.user.id);
    if (!session) return res.status(404).json({ status: 'error', message: 'Session not found' });
    await revokeSession(session.id);
    if (session.id === req.user.sessionId) clearRefreshCookie(res);
    return res.json({ status: 'success', message: 'Session revoked' });
  } catch (error) { return next(error); }
};

export const logoutOtherDevices = async (req, res, next) => {
  try {
    const count = await revokeUserSessions(req.user.id, req.user.sessionId);
    return res.json({ status: 'success', revoked: count });
  } catch (error) { return next(error); }
};

export const logoutEverywhere = async (req, res, next) => {
  try {
    const count = await revokeUserSessions(req.user.id);
    clearRefreshCookie(res);
    return res.json({ status: 'success', revoked: count });
  } catch (error) { return next(error); }
};

export const getCurrentUser = async (req, res, next) => {
  try {
    const user = await AuthModel.findUserById(req.user.id);
    if (!user || (user.accountStatus && user.accountStatus !== 'ACTIVE')) return res.status(401).json({ status: 'error', message: 'Authentication required' });
    const organizations = await membershipsFor(user.id);
    const currentOrganization = req.user.organizationId
      ? await activeMembershipFor(user.id, req.user.organizationId)
      : null;
    return res.status(200).json({ status: 'success', user: toUserResponse(user), organizations, currentOrganization });
  } catch (error) {
    if (error?.status && error?.code) return res.status(error.status).json({ status: 'error', error: { code: error.code, message: 'Access denied.' } });
    return next(error);
  }
};

const resetMessage = 'If an account exists for that email, a reset link has been sent.';
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const requestPasswordReset = async (req, res, next) => {
  try {
    const user = await AuthModel.findUserByEmail(req.body.email);
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await AuthModel.createPasswordResetToken(user.id, hashToken(rawToken), expiresAt);
      const baseUrl = process.env.CLIENT_URL || 'http://localhost:5173';
      await sendPasswordResetEmail({ email: user.email, resetUrl: `${baseUrl}/reset-password/${user.id}/${rawToken}` });
    }
    return res.status(202).json({ status: 'success', message: resetMessage });
  } catch (error) { return next(error); }
};

export const confirmPasswordReset = async (req, res, next) => {
  try {
    const { uid, token, password } = req.body;
    const reset = await AuthModel.findPasswordResetToken(hashToken(token));
    if (!reset || reset.userId !== uid || reset.usedAt || reset.revokedAt || reset.expiresAt <= new Date()) {
      return res.status(400).json({ status: 'error', message: 'Invalid or expired reset token' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await AuthModel.updatePassword(uid, passwordHash);
    await AuthModel.consumePasswordResetToken(reset.id);
    await AuthModel.revokeRefreshTokens(uid);
    await revokeUserSessions(uid);
    return res.status(200).json({ status: 'success', message: 'Password reset successfully' });
  } catch (error) { return next(error); }
};
