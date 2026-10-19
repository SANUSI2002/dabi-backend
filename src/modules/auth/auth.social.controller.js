// Sign in or sign up with Google / Apple. Which Sabi account a provider identity opens:
//   1. one already connected to that provider account (by its stable subject id), else
//   2. the account with the same email, if the provider says it verified that email (connected now), else
//   3. a new patient account — but only once the person has accepted the terms. From the professional
//      portal (intent "professional") no patient is ever created: the person gets a sign-up hand-off for
//      the professional registration form instead (see doctors/onboarding.service.js).
// Two-step verification still applies, and only ACTIVE accounts (or unverified sign-ups, which the
// provider's verified email now proves) can sign in.
import prisma from '../../config/db.js';
import { recordAudit } from '../audit/audit.service.js';
import * as AuthModel from './auth.model.js';
import { completeSignIn } from './auth.controller.js';
import { APPLE, GOOGLE, appleIdentity, googleIdentity, identityFromSignupToken, issueNonce, publicProviders, signupToken } from './auth.social.js';

const label = (provider) => (provider === APPLE ? 'Apple' : 'Google');
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

async function resolveAccount(identity, { consentGiven }) {
  const { provider, subject } = identity;
  const link = await prisma.userIdentityProvider.findUnique({ where: { provider_subject: { provider, subject } } });
  if (link) {
    await prisma.userIdentityProvider.update({ where: { id: link.id }, data: { lastUsedAt: new Date(), ...(identity.email ? { email: identity.email } : {}) } });
    return { user: await AuthModel.findUserById(link.userId), action: `SIGNED_IN_${provider}` };
  }
  if (!identity.email || !identity.emailVerified) {
    throw fail(400, 'SOCIAL_EMAIL_UNVERIFIED', `Your ${label(provider)} account doesn't share a verified email address, so we can't connect it. Sign in with your email and password instead.`);
  }

  const existing = await AuthModel.findUserByEmail(identity.email);
  if (existing) {
    const unverifiedSignup = existing.accountStatus === 'PENDING' && !existing.emailVerifiedAt;
    if (existing.accountStatus !== 'ACTIVE' && !unverifiedSignup) throw fail(403, 'ACCOUNT_UNAVAILABLE', "This account can't sign in right now. Contact Sabi support.");
    const other = await prisma.userIdentityProvider.findUnique({ where: { userId_provider: { userId: existing.id, provider } } });
    if (other) throw fail(409, 'SOCIAL_ACCOUNT_CONFLICT', `This Sabi account is already connected to a different ${label(provider)} account.`);
    const now = new Date();
    const replacement = unverifiedSignup ? await AuthModel.unusablePasswordHash() : null;
    await prisma.$transaction(async (tx) => {
      if (unverifiedSignup) {
        // Whoever typed the password on an unverified sign-up never proved they own this email; the
        // provider just did. So the account is activated and that password stops working.
        await tx.user.update({ where: { id: existing.id }, data: { accountStatus: 'ACTIVE', emailVerifiedAt: now, password: replacement } });
        await tx.emailVerificationToken.updateMany({ where: { userId: existing.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
        await tx.passwordResetToken.updateMany({ where: { userId: existing.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      }
      await tx.userIdentityProvider.create({ data: { userId: existing.id, provider, subject, email: identity.email } });
    });
    await recordAudit(prisma, { actorUserId: existing.id, action: `${provider}_CONNECTED` });
    return { user: await AuthModel.findUserById(existing.id), action: `SIGNED_IN_${provider}` };
  }

  if (!consentGiven) return { signupRequired: true };
  try {
    const user = await AuthModel.createSocialPatient({ email: identity.email, firstName: identity.firstName, lastName: identity.lastName, provider, subject });
    await recordAudit(prisma, { actorUserId: user.id, action: `SIGNED_UP_${provider}` });
    return { user, action: `SIGNED_IN_${provider}`, created: true };
  } catch (error) {
    // Two tabs finishing at once: the other one created the account; sign in to it.
    if (error?.code === 'P2002') return resolveAccount(identity, { consentGiven: false });
    throw error;
  }
}

async function finish(req, res, identity, consentGiven, intent = 'patient') {
  const result = await resolveAccount(identity, { consentGiven: consentGiven && intent === 'patient' });
  if (result.signupRequired) {
    return res.status(200).json({
      status: 'signup_required', signupToken: signupToken(identity),
      profile: { provider: identity.provider, email: identity.email, firstName: identity.firstName, lastName: identity.lastName },
    });
  }
  if (!result.user || result.user.accountStatus !== 'ACTIVE') throw fail(403, 'ACCOUNT_UNAVAILABLE', "This account can't sign in right now. Contact Sabi support.");
  return completeSignIn(req, res, result.user, { action: result.action, extra: { provider: identity.provider, accountCreated: !!result.created } });
}

const handle = (work) => async (req, res, next) => {
  try { return await work(req, res); }
  catch (error) {
    if (error?.status && error?.code) return res.status(error.status).json({ status: 'error', error: { code: error.code, message: error.message }, message: error.message });
    return next(error);
  }
};

export const socialProviders = (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'success', data: publicProviders() });
export const socialNonce = (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'success', data: { nonce: issueNonce() } });
export const googleSignIn = handle(async (req, res) => finish(req, res, await googleIdentity(req.body.code), req.body.consentGiven === true, req.body.intent));
export const appleSignIn = handle(async (req, res) => finish(req, res, await appleIdentity(req.body.idToken, req.body.nonce, req.body), req.body.consentGiven === true, req.body.intent));
export const completeSocialSignup = handle(async (req, res) => {
  const identity = identityFromSignupToken(req.body.signupToken);
  if (![GOOGLE, APPLE].includes(identity.provider)) throw fail(401, 'SOCIAL_SIGNUP_EXPIRED', 'Please choose Google or Apple again.');
  return finish(req, res, identity, true);
});
