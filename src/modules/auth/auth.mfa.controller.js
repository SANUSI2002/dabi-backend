import prisma from '../../config/db.js';
import * as AuthModel from './auth.model.js';
import { generateAccessToken } from './auth.token.js';
import { browserRequest, setRefreshCookie } from './auth.cookie.js';
import { createSession, revokeUserSessions } from './auth.session.js';
import { beginEnrollment, confirmEnrollment, consumeLoginChallenge, disableMfa, hasActiveMfa, markStepUp, regenerateRecoveryCodes } from './auth.mfa.js';

const respondError = (error, res, next) => {
  if (error?.code === 'MFA_DENIED') return res.status(401).json({ status: 'error', message: 'Verification failed' });
  if (error?.code === 'MFA_ALREADY_ENABLED') return res.status(409).json({ status: 'error', message: 'Authenticator is already enabled' });
  if (error?.code === 'MFA_UNAVAILABLE') return res.status(503).json({ status: 'error', message: 'Authenticator service is not configured' });
  return next(error);
};

export const verifyMfaLogin = async (req, res, next) => {
  try {
    const userId = await consumeLoginChallenge(req.body.challengeToken, req.body);
    const user = await AuthModel.findUserById(userId);
    if (!user || user.accountStatus !== 'ACTIVE') return res.status(401).json({ status: 'error', message: 'Verification failed' });
    const { session, refreshToken } = await createSession(user, req.get('user-agent') || '', { mfaVerified: true });
    if (browserRequest(req)) setRefreshCookie(res, refreshToken);
    return res.json({ status: 'success', accessToken: generateAccessToken(user, { sessionId: session.id }), ...(!browserRequest(req) ? { refreshToken } : {}), user: { id: user.id, email: user.email, patientId: user.patientId, roles: user.roles.map(({ role }) => role) } });
  } catch (error) { return respondError(error, res, next); }
};

export const mfaStatus = async (req, res, next) => {
  try {
    const enabled = await hasActiveMfa(req.user.id);
    const recoveryCodesRemaining = enabled ? await prisma.mfaRecoveryCode.count({ where: { userId: req.user.id, usedAt: null } }) : 0;
    return res.json({ status: 'success', enabled, recoveryCodesRemaining });
  } catch (error) { return next(error); }
};

export const enrollTotp = async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store'); return res.json({ status: 'success', ...(await beginEnrollment(req.user.id, req.body.password)) }); }
  catch (error) { return respondError(error, res, next); }
};

export const confirmTotp = async (req, res, next) => {
  try {
    const recoveryCodes = await confirmEnrollment(req.user.id, req.body.code, req.user.sessionId);
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', enabled: true, recoveryCodes });
  } catch (error) { return respondError(error, res, next); }
};

export const stepUp = async (req, res, next) => {
  try {
    await markStepUp(req.user.id, req.user.sessionId, req.body);
    return res.json({ status: 'success', verifiedUntil: new Date(Date.now() + 10 * 60_000).toISOString() });
  } catch (error) { return respondError(error, res, next); }
};

export const replaceRecoveryCodes = async (req, res, next) => {
  try {
    const recoveryCodes = await regenerateRecoveryCodes(req.user.id);
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', recoveryCodes });
  } catch (error) { return next(error); }
};

export const removeMfa = async (req, res, next) => {
  try {
    await disableMfa(req.user.id, req.body.password);
    await revokeUserSessions(req.user.id, req.user.sessionId);
    return res.json({ status: 'success', enabled: false });
  } catch (error) { return respondError(error, res, next); }
};
