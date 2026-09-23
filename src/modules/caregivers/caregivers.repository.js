import prisma from '../../config/db.js';

export const caregiverProfileSelect = {
  firstName: true, lastName: true, country: true, state: true, city: true,
  caregiverType: true, connectionMode: true, connectionReference: true, relationship: true,
  termsAcceptedAt: true, privacyAcceptedAt: true, consentVersion: true, createdAt: true,
};
export const create = (data) => prisma.user.create({ data,
  select: { id: true, email: true, roles: { select: { role: true } },
    caregiverProfile: { select: caregiverProfileSelect } },
});
export const profile = (userId) => prisma.user.findFirst({
  where: { id: userId, roles: { some: { role: 'CAREGIVER' } } },
  select: { id: true, email: true, full_name: true, phone_number: true, dob: true,
    caregiverProfile: { select: caregiverProfileSelect } },
});
export const links = (caregiverId) => prisma.careRelationship.findMany({
  where: { caregiverId, status: 'ACTIVE', revokedAt: null, permissions: { isEmpty: false } },
  select: { id: true, patientId: true, permissions: true }, orderBy: { createdAt: 'asc' },
});
