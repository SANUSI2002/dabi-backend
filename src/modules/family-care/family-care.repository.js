import prisma from '../../config/db.js';

export const transaction = (work) => prisma.$transaction(work, { isolationLevel: 'Serializable' });
export const isPatient = (tx, userId) => tx.userRole.findFirst({ where: { userId, role: 'PATIENT' }, select: { id: true } });
export const user = (tx, id) => tx.user.findUnique({ where: { id }, select: { id: true, email: true, full_name: true } });
export const byReference = (tx, patientId) => tx.user.findUnique({ where: { patientId }, select: { id: true, email: true } });
export const memberSelect = {
  id: true, patientId: true, caregiverId: true, caregiverEmail: true, relationshipType: true,
  relationshipLabel: true, permissionLevel: true, requestedPermissions: true, invitationKind: true,
  joinRequestedAt: true, permissions: true, status: true, expiresAt: true, respondedAt: true, revokedAt: true, createdAt: true,
};
export const members = (tx, where) => tx.careRelationship.findMany({ where, select: memberSelect, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
export const member = (tx, where) => tx.careRelationship.findFirst({ where, select: memberSelect });
export const byToken = (tx, invitationTokenHash) => member(tx, { invitationTokenHash });
export const createMember = (tx, data) => tx.careRelationship.create({ data, select: memberSelect });
export const changeMember = (tx, where, data) => tx.careRelationship.updateMany({ where, data });
export const dependentSelect = {
  id: true, patientId: true, fullName: true, nickname: true, dateOfBirth: true, gender: true,
  bloodGroup: true, genotype: true, allergies: true, conditions: true, careType: true,
  immunizationStatus: true, milestones: true, weightKg: true, heightCm: true,
  primaryPhysician: true, insuranceProvider: true, policyNumber: true, coManagerIds: true, createdAt: true, updatedAt: true,
};
export const dependents = (tx, patientId) => tx.dependentProfile.findMany({
  where: { patientId }, select: { id: true, fullName: true, nickname: true, dateOfBirth: true, gender: true, careType: true }, orderBy: { createdAt: 'asc' },
});
export const dependent = (tx, where) => tx.dependentProfile.findFirst({ where, select: dependentSelect });
export const createDependent = (tx, data) => tx.dependentProfile.create({ data, select: dependentSelect });
export const changeDependent = (tx, where, data) => tx.dependentProfile.updateMany({ where, data });
export const removeDependent = (tx, where) => tx.dependentProfile.deleteMany({ where });
export const audit = (tx, userId, type, id) => tx.activityLog.create({ data: { userId, type, description: 'Family circle changed', meta: { id } } });
