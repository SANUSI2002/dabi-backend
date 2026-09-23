import { caregiverProfileSelect } from '../caregivers/caregivers.repository.js';
import bcrypt from 'bcryptjs';
import prisma from '../../config/db.js';

const SALT_ROUNDS = 12;
const MAX_PATIENT_ID_ATTEMPTS = 5;
const authUserInclude = { profile: true, caregiverProfile: { select: caregiverProfileSelect }, roles: { select: { role: true } } };

const generatePatientId = () => `#SHM${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;

export const findUserByEmail = async (email) => {
  const exact = email.trim();
  const user = await prisma.user.findUnique({ where: { email: exact }, include: authUserInclude });
  return user || (exact.toLowerCase() !== exact ? prisma.user.findUnique({ where: { email: exact.toLowerCase() }, include: authUserInclude }) : null);
};
export const findUserById = (id) => prisma.user.findUnique({ where: { id }, include: authUserInclude });

export const createPatient = async ({ email, password, firstName, lastName, phoneNumber, dateOfBirth, gender }) => {
  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  for (let attempt = 1; attempt <= MAX_PATIENT_ID_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.user.create({
        data: {
          patientId: generatePatientId(), email: email.trim().toLowerCase(), password: hashedPassword, accountStatus: 'PENDING',
          full_name: `${firstName.trim()} ${lastName.trim()}`, phone_number: phoneNumber,
          dob: dateOfBirth ? new Date(dateOfBirth) : null,
          profile: { create: { consentGiven: true, consentGivenAt: new Date(), gender } },
          roles: { create: { role: 'PATIENT' } },
          healthMetrics: { create: { health_score: 0 } },
        },
        include: authUserInclude,
      });
    } catch (error) {
      const target = error?.meta?.target;
      const isPatientIdCollision = error?.code === 'P2002' && (Array.isArray(target) ? target.includes('patient_id') : String(target).includes('patient_id'));
      if (isPatientIdCollision && attempt < MAX_PATIENT_ID_ATTEMPTS) continue;
      throw error;
    }
  }
  throw new Error('Could not generate a unique patient ID, please retry');
};

export const storeRefreshToken = (userId, token, expiresAt) => prisma.refreshToken.create({ data: { token, userId, expiresAt } });
export const findRefreshToken = (token) => prisma.refreshToken.findUnique({ where: { token } });
export const deleteRefreshTokenById = (id) => prisma.refreshToken.delete({ where: { id } });
export const deleteRefreshToken = (token) => prisma.refreshToken.deleteMany({ where: { token } });
export const revokeRefreshTokens = (userId) => prisma.refreshToken.deleteMany({ where: { userId } });
export const createPasswordResetToken = (userId, tokenHash, expiresAt) => prisma.passwordResetToken.create({ data: { userId, tokenHash, expiresAt } });
export const revokePasswordResetToken = (id) => prisma.passwordResetToken.update({ where: { id }, data: { revokedAt: new Date() } });
export const findPasswordResetToken = (tokenHash) => prisma.passwordResetToken.findUnique({ where: { tokenHash } });
export const consumePasswordResetToken = (id) => prisma.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } });
export const revokeOtherPasswordResetTokens = (userId, usedId) => prisma.passwordResetToken.updateMany({ where: { userId, id: { not: usedId }, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
export const updatePassword = (userId, password) => prisma.user.update({ where: { id: userId }, data: { password } });
export const createEmailVerificationToken = (userId, tokenHash, expiresAt) => prisma.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt } });
export const latestEmailVerificationToken = (userId) => prisma.emailVerificationToken.findFirst({ where: { userId, usedAt: null, revokedAt: null }, orderBy: { createdAt: 'desc' } });
export const revokeEmailVerificationToken = (id) => prisma.emailVerificationToken.update({ where: { id }, data: { revokedAt: new Date() } });
export const revokeOtherEmailVerificationTokens = (userId, id) => prisma.emailVerificationToken.updateMany({ where: { userId, id: { not: id }, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
export const confirmEmailVerificationToken = async (userId, tokenHash) => {
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const token = await tx.emailVerificationToken.findUnique({ where: { tokenHash } });
      if (!token || token.userId !== userId || token.usedAt || token.revokedAt || token.expiresAt <= now) return false;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { accountStatus: true, emailVerifiedAt: true } });
      if (user?.accountStatus !== 'PENDING' || user.emailVerifiedAt) return false;
      const claimed = await tx.emailVerificationToken.updateMany({ where: { id: token.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claimed.count !== 1) return false;
      const activated = await tx.user.updateMany({ where: { id: userId, accountStatus: 'PENDING', emailVerifiedAt: null }, data: { accountStatus: 'ACTIVE', emailVerifiedAt: now } });
      if (activated.count !== 1) { const conflict = new Error('Email verification conflicted with an account change'); conflict.code = 'EMAIL_VERIFICATION_CONFLICT'; throw conflict; }
      await tx.emailVerificationToken.updateMany({ where: { userId, id: { not: token.id }, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      return true;
    });
  } catch (error) {
    if (error?.code === 'EMAIL_VERIFICATION_CONFLICT') return false;
    throw error;
  }
};
