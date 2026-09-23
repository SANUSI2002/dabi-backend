import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import prisma from '../../config/db.js';
import { base32Encode, decryptSecret, encryptSecret, matchingTotpStep } from './auth.mfa-crypto.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const denied = () => Object.assign(new Error('Verification failed'), { code: 'MFA_DENIED' });
const recoveryValue = () => base32Encode(crypto.randomBytes(16)).match(/.{1,4}/g).join('-');
const normalizeRecovery = (value) => String(value || '').replace(/[-\s]/g, '').toUpperCase();
const recoverySet = () => Array.from({ length: 10 }, recoveryValue);
const recoveryRows = (userId, codes) => codes.map((code) => ({ userId, tokenHash: hash(normalizeRecovery(code)) }));

export const hasActiveMfa = async (userId) => !!(await prisma.mfaTotp.findUnique({ where: { userId }, select: { enabledAt: true } }))?.enabledAt;

export const beginEnrollment = async (userId, password) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, password: true } });
  if (!user || !(await bcrypt.compare(password, user.password))) throw denied();
  if (await hasActiveMfa(userId)) throw Object.assign(new Error('MFA already enabled'), { code: 'MFA_ALREADY_ENABLED' });
  const secret = crypto.randomBytes(20);
  const encoded = base32Encode(secret);
  await prisma.mfaTotp.upsert({ where: { userId },
    create: { userId, encryptedSecret: encryptSecret(secret) },
    update: { encryptedSecret: encryptSecret(secret), enabledAt: null, lastUsedStep: null },
  });
  const label = encodeURIComponent(`Sabi Health:${user.email || userId}`);
  const uri = `otpauth://totp/${label}?secret=${encoded}&issuer=${encodeURIComponent('Sabi Health')}&algorithm=SHA1&digits=6&period=30`;
  return { secret: encoded, otpauthUri: uri };
};

export const confirmEnrollment = async (userId, code, sessionId) => {
  const method = await prisma.mfaTotp.findUnique({ where: { userId } });
  if (!method || method.enabledAt || method.updatedAt.getTime() < Date.now() - 10 * 60_000) throw denied();
  const step = matchingTotpStep(decryptSecret(method.encryptedSecret), code);
  if (step === null) throw denied();
  const codes = recoverySet();
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const result = await tx.mfaTotp.updateMany({ where: { userId, enabledAt: null, lastUsedStep: null }, data: { enabledAt: now, lastUsedStep: step } });
    if (result.count !== 1) throw denied();
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({ data: recoveryRows(userId, codes) });
    await tx.userProfile.upsert({ where: { userId }, update: { two_factor_auth: true }, create: { userId, two_factor_auth: true } });
    const session = await tx.authSession.updateMany({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now } }, data: { mfaVerifiedAt: now } });
    if (session.count !== 1) throw denied();
  });
  return codes;
};

export const verifyFactor = async (userId, { code, recoveryCode }) => {
  const method = await prisma.mfaTotp.findUnique({ where: { userId } });
  if (!method?.enabledAt) return false;
  if (code) {
    const step = matchingTotpStep(decryptSecret(method.encryptedSecret), code);
    if (step === null) return false;
    const used = await prisma.mfaTotp.updateMany({
      where: { userId, enabledAt: { not: null }, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step },
    });
    return used.count === 1;
  }
  if (recoveryCode) {
    const normalized = normalizeRecovery(recoveryCode);
    if (!/^[A-Z2-7]{26}$/.test(normalized)) return false;
    const row = await prisma.mfaRecoveryCode.findUnique({ where: { tokenHash: hash(normalized) } });
    if (!row || row.userId !== userId || row.usedAt) return false;
    const used = await prisma.mfaRecoveryCode.updateMany({ where: { id: row.id, userId, usedAt: null }, data: { usedAt: new Date() } });
    return used.count === 1;
  }
  return false;
};

export const beginLoginChallenge = async (userId) => {
  const challengeToken = crypto.randomBytes(32).toString('base64url');
  await prisma.mfaLoginChallenge.create({ data: { userId, tokenHash: hash(challengeToken), expiresAt: new Date(Date.now() + 5 * 60_000) } });
  return challengeToken;
};

export const consumeLoginChallenge = async (challengeToken, factor) => {
  const challenge = await prisma.mfaLoginChallenge.findUnique({ where: { tokenHash: hash(challengeToken) } });
  const now = new Date();
  if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= 5) throw denied();
  const attempt = await prisma.mfaLoginChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: 5 } }, data: { attempts: { increment: 1 } },
  });
  if (attempt.count !== 1 || !(await verifyFactor(challenge.userId, factor))) throw denied();
  const consumed = await prisma.mfaLoginChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now } });
  if (consumed.count !== 1) throw denied();
  return challenge.userId;
};

export const markStepUp = async (userId, sessionId, factor) => {
  if (!(await verifyFactor(userId, factor))) throw denied();
  const result = await prisma.authSession.updateMany({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } }, data: { mfaVerifiedAt: new Date() } });
  if (result.count !== 1) throw denied();
};

export const regenerateRecoveryCodes = async (userId) => {
  const codes = recoverySet();
  await prisma.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({ data: recoveryRows(userId, codes) });
  });
  return codes;
};

export const disableMfa = async (userId, password) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
  if (!user || !(await bcrypt.compare(password, user.password))) throw denied();
  await prisma.$transaction(async (tx) => {
    const removed = await tx.mfaTotp.deleteMany({ where: { userId, enabledAt: { not: null } } });
    if (removed.count !== 1) throw denied();
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.userProfile.updateMany({ where: { userId }, data: { two_factor_auth: false } });
  });
};
