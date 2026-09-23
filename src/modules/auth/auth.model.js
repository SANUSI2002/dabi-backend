import { caregiverProfileSelect } from '../caregivers/caregivers.repository.js';
import bcrypt from 'bcryptjs';
import prisma from '../../config/db.js';

const SALT_ROUNDS = 12;
const MAX_PATIENT_ID_ATTEMPTS = 5;
const authUserInclude = { profile: true, caregiverProfile: { select: caregiverProfileSelect }, roles: { select: { role: true } } };

const generatePatientId = () => `#SHM${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;

export const findUserByEmail = (email) => prisma.user.findUnique({ where: { email }, include: authUserInclude });
export const findUserById = (id) => prisma.user.findUnique({ where: { id }, include: authUserInclude });

export const createPatient = async ({ email, password, firstName, lastName, phoneNumber, dateOfBirth, gender }) => {
  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  for (let attempt = 1; attempt <= MAX_PATIENT_ID_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.user.create({
        data: {
          patientId: generatePatientId(), email, password: hashedPassword,
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
export const findPasswordResetToken = (tokenHash) => prisma.passwordResetToken.findUnique({ where: { tokenHash } });
export const consumePasswordResetToken = (id) => prisma.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } });
export const updatePassword = (userId, password) => prisma.user.update({ where: { id: userId }, data: { password } });
