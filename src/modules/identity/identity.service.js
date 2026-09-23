import * as repository from './identity.repository.js';

export const identityError = (code, status) => Object.assign(new Error(code), { code, status });

const facility = (organization) => organization.organisation ?? organization.pharmacy;
const facilityStatus = (organization) => organization.organisation?.status ?? organization.pharmacy?.complianceStatus;

export const toMembershipResponse = (membership) => ({
  id: membership.id,
  status: membership.status,
  joinedAt: membership.joinedAt,
  organization: {
    id: membership.organization.id,
    facilityId: facility(membership.organization)?.id,
    type: membership.organization.type,
    name: facility(membership.organization)?.name,
    status: facilityStatus(membership.organization),
  },
  roles: membership.roles.map(({ role }) => role.code),
  permissions: [...new Set(membership.roles.flatMap(({ role }) => role.permissions.map(({ permissionCode }) => permissionCode)))].sort(),
});

export const activeIdentity = async (userId) => {
  const user = await repository.findIdentity(userId);
  if (!user || user.accountStatus !== 'ACTIVE') throw identityError('ACCOUNT_INACTIVE', 401);
  return user;
};

export const membershipsFor = async (userId) => {
  await activeIdentity(userId);
  return (await repository.listMemberships(userId)).map(toMembershipResponse);
};

export const activeMembershipFor = async (userId, organizationId) => {
  await activeIdentity(userId);
  const membership = await repository.findActiveMembership(userId, organizationId);
  if (!membership || membership.status !== 'ACTIVE') throw identityError('ORGANIZATION_ACCESS_DENIED', 403);
  const status = facilityStatus(membership.organization);
  if (!['VERIFIED'].includes(status)) throw identityError('ORGANIZATION_INACTIVE', 403);
  const professionalRoles = membership.roles.map(({ role }) => role.code).filter((code) => ['DOCTOR', 'NURSE', 'PHARMACIST'].includes(code));
  if (professionalRoles.length) {
    const profile = await repository.professionalProfileFor(userId);
    if (profile?.verificationStatus !== 'VERIFIED' || !professionalRoles.every((code) => profile.professionType === code)) {
      throw identityError('PROFESSIONAL_VERIFICATION_REQUIRED', 403);
    }
  }
  return toMembershipResponse(membership);
};

export const platformAccessFor = async (userId) => {
  await activeIdentity(userId);
  const assignments = await repository.findPlatformRoles(userId);
  return {
    roles: assignments.map(({ role }) => role.code),
    permissions: [...new Set(assignments.flatMap(({ role }) => role.permissions.map(({ permissionCode }) => permissionCode)))].sort(),
  };
};

export const acceptOwnMembership = async (userId, membershipId) => {
  await activeIdentity(userId);
  return repository.transaction(async (tx) => {
    const membership = await repository.findMembershipById(tx, membershipId, userId);
    if (!membership || membership.status !== 'PENDING') throw identityError('MEMBERSHIP_NOT_FOUND', 404);
    if (membership.organization?.type === 'PHARMACY' && membership.roles?.some(({ roleCode }) => roleCode === 'PHARMACIST')) {
      throw identityError('PHARMACY_PROFESSIONAL_ACCEPTANCE_REQUIRED', 403);
    }
    const result = await repository.acceptMembership(tx, membershipId, userId);
    if (result.count !== 1) throw identityError('MEMBERSHIP_CONFLICT', 409);
    await repository.auditMembership(tx, userId, 'MEMBERSHIP_ACCEPTED', membershipId, membership.organizationId);
    return { membershipId, organizationId: membership.organizationId, status: 'ACTIVE' };
  });
};

const staffRoles = {
  // Verified pharmacists join through the existing professional invite/accept flow.
  PHARMACY: new Set(['PHARMACY_STAFF']),
  HOSPITAL: new Set(['HOSPITAL_ADMIN', 'DOCTOR', 'NURSE', 'PHARMACIST', 'FINANCE_OFFICER', 'INVENTORY_OFFICER', 'HR_OFFICER', 'RECEPTIONIST']),
  CLINIC: new Set(['HOSPITAL_ADMIN', 'DOCTOR', 'NURSE', 'PHARMACIST', 'FINANCE_OFFICER', 'INVENTORY_OFFICER', 'HR_OFFICER', 'RECEPTIONIST']),
  LABORATORY: new Set(['FINANCE_OFFICER']),
  DIAGNOSTIC_CENTRE: new Set(['FINANCE_OFFICER']),
  OTHER: new Set(['HOSPITAL_ADMIN', 'DOCTOR', 'NURSE', 'FINANCE_OFFICER']),
};

export const inviteExistingIdentity = async (actorId, accessContext, { email, roleCodes }) => {
  const organizationId = accessContext.organization.id;
  if (!roleCodes.every((code) => staffRoles[accessContext.organization.type]?.has(code))) {
    throw identityError('ROLE_SCOPE_DENIED', 403);
  }
  if (roleCodes.some((code) => ['HOSPITAL_ADMIN', 'FINANCE_OFFICER'].includes(code)) && !accessContext.roles.includes('ORGANISATION_OWNER')) {
    throw identityError('ROLE_SCOPE_DENIED', 403);
  }
  try {
    return await repository.transaction(async (tx) => {
      const users = await repository.findUsersByEmail(tx, email);
      if (users.length !== 1 || users[0].accountStatus !== 'ACTIVE' || users[0].id === actorId) {
        throw identityError('IDENTITY_NOT_AVAILABLE', 404);
      }
      if (await repository.findOrganizationMembership(tx, users[0].id, organizationId)) {
        throw identityError('MEMBERSHIP_CONFLICT', 409);
      }
      const professionalRoles = roleCodes.filter((code) => ['DOCTOR', 'NURSE', 'PHARMACIST'].includes(code));
      if (professionalRoles.length) {
        const profile = await repository.findProfessionalProfile(tx, users[0].id);
        if (profile?.verificationStatus !== 'VERIFIED' || !professionalRoles.every((code) => profile.professionType === code)) {
          throw identityError('PROFESSIONAL_VERIFICATION_REQUIRED', 403);
        }
      }
      const membership = await repository.createMembership(tx, users[0].id, organizationId, roleCodes);
      await repository.auditMembership(tx, actorId, 'MEMBERSHIP_INVITED', membership.id, organizationId);
      return { id: membership.id, status: membership.status, organizationId };
    });
  } catch (error) {
    if (error?.code === 'P2002') throw identityError('MEMBERSHIP_CONFLICT', 409);
    throw error;
  }
};

export const managedMemberships = (organizationId) =>
  repository.transaction((tx) => repository.listOrganizationMemberships(tx, organizationId));

export const revokeManagedMembership = (actorId, organizationId, membershipId) => repository.transaction(async (tx) => {
  const membership = await repository.findManagedMembership(tx, membershipId, organizationId);
  if (!membership || membership.userId === actorId || membership.status === 'REVOKED') {
    throw identityError('MEMBERSHIP_NOT_FOUND', 404);
  }
  if (membership.roles?.some(({ roleCode }) => ['ORGANISATION_OWNER', 'PHARMACY_ADMIN'].includes(roleCode))) {
    throw identityError('OWNER_TRANSFER_REQUIRED', 403);
  }
  const result = await repository.revokeMembership(tx, membershipId, organizationId);
  if (result.count !== 1) throw identityError('MEMBERSHIP_CONFLICT', 409);
  await repository.revokeLegacyPharmacyStaff(tx, organizationId, membership.userId);
  await repository.auditMembership(tx, actorId, 'MEMBERSHIP_REVOKED', membershipId, organizationId);
  return { id: membershipId, status: 'REVOKED' };
});
