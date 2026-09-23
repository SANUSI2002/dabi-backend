import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import * as repository from './caregivers.repository.js';

export const register = async ({ account, caregiverType, connection }) => {
  const now = new Date();
  // A nested Prisma create is atomic. No patient profile, relationship, or permission is created.
  const user = await repository.create({
    patientId: `CG-${randomUUID()}`, // Existing User schema requires a unique internal identifier.
    email: account.email, password: await bcrypt.hash(account.password, 12),
    full_name: `${account.firstName} ${account.lastName}`, phone_number: account.phone,
    dob: new Date(account.dateOfBirth), roles: { create: { role: 'CAREGIVER' } },
    caregiverProfile: { create: {
      firstName: account.firstName, lastName: account.lastName,
      country: account.country, state: account.state, city: account.city, caregiverType,
      connectionMode: connection.mode,
      connectionReference: connection.mode === 'invite' ? connection.inviteContact : connection.patientReference,
      relationship: connection.relationship,
      termsAcceptedAt: now, privacyAcceptedAt: now, consentVersion: '1.0',
    } },
  });
  return { user: { id: user.id, email: user.email, roles: user.roles.map(({ role }) => role), caregiverProfile: user.caregiverProfile },
    onboarding: { status: 'AWAITING_PATIENT_INVITATION', linkedPatients: [] } };
};
export const me = async (userId) => {
  const user = await repository.profile(userId);
  if (!user?.caregiverProfile) throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' });
  const linkedPatients = await repository.links(userId);
  return { user, onboarding: { status: linkedPatients.length ? 'LINKED' : 'AWAITING_PATIENT_INVITATION', linkedPatients } };
};
