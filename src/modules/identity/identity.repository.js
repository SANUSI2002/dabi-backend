import prisma from '../../config/db.js';

const roleSelect = {
  role: {
    select: {
      code: true,
      scope: true,
      permissions: { select: { permissionCode: true } },
    },
  },
};

const membershipSelect = {
  id: true,
  userId: true,
  status: true,
  joinedAt: true,
  organization: {
    select: {
      id: true,
      type: true,
      organisation: { select: { id: true, name: true, status: true } },
      pharmacy: { select: { id: true, name: true, complianceStatus: true } },
    },
  },
  roles: { select: roleSelect },
};

export const findIdentity = (userId) => prisma.user.findUnique({
  where: { id: userId },
  select: { id: true, accountStatus: true },
});

export const listMemberships = (userId) => prisma.organizationMembership.findMany({
  where: { userId, status: { in: ['ACTIVE', 'PENDING', 'SUSPENDED'] } },
  select: membershipSelect,
  orderBy: { createdAt: 'asc' },
});

export const findActiveMembership = (userId, organizationId) => prisma.organizationMembership.findFirst({
  where: { userId, organizationId, status: 'ACTIVE' },
  select: membershipSelect,
});

export const findPlatformRoles = (userId) => prisma.platformRoleAssignment.findMany({
  where: { userId },
  select: roleSelect,
});

export const createFacilityOwner = async (tx, { userId, organisationId, pharmacyId, type, roleCode }) => {
  if (Boolean(organisationId) === Boolean(pharmacyId)) throw new Error('Exactly one facility is required');
  const organization = await tx.identityOrganization.create({
    data: { type, ...(organisationId ? { organisationId } : { pharmacyId }) },
    select: { id: true },
  });
  const membership = await tx.organizationMembership.create({
    data: { userId, organizationId: organization.id, status: 'ACTIVE', joinedAt: new Date() },
    select: { id: true },
  });
  await tx.membershipRole.create({ data: { membershipId: membership.id, roleCode } });
  return membership;
};

export const transaction = (work) => prisma.$transaction(work);
export const findMembershipById = (tx, id, userId) => tx.organizationMembership.findFirst({
  where: { id, userId },
  select: { id: true, status: true, organizationId: true, organization: { select: { type: true } }, roles: { select: { roleCode: true } } },
});
export const acceptMembership = (tx, id, userId) => tx.organizationMembership.updateMany({
  where: { id, userId, status: 'PENDING' },
  data: { status: 'ACTIVE', joinedAt: new Date() },
});

export const findUsersByEmail = (tx, email) => tx.user.findMany({
  where: { email: { equals: email, mode: 'insensitive' } },
  select: { id: true, accountStatus: true },
  take: 2,
});

export const findProfessionalProfile = (tx, userId) => tx.professionalProfile.findUnique({
  where: { userId },
  select: { professionType: true, verificationStatus: true },
});
export const professionalProfileFor = (userId) => findProfessionalProfile(prisma, userId);

export const findOrganizationMembership = (tx, userId, organizationId) => tx.organizationMembership.findUnique({
  where: { userId_organizationId: { userId, organizationId } },
  select: { id: true, status: true },
});

export const createMembership = (tx, userId, organizationId, roleCodes) => tx.organizationMembership.create({
  data: {
    userId,
    organizationId,
    status: 'PENDING',
    roles: { create: roleCodes.map((roleCode) => ({ roleCode })) },
  },
  select: { id: true, status: true },
});

export const listOrganizationMemberships = (tx, organizationId) => tx.organizationMembership.findMany({
  where: { organizationId },
  select: {
    id: true,
    status: true,
    user: { select: { id: true, email: true, full_name: true } },
    roles: { select: { roleCode: true } },
  },
  orderBy: { createdAt: 'asc' },
});

export const findManagedMembership = (tx, id, organizationId) => tx.organizationMembership.findFirst({
  where: { id, organizationId },
  select: { id: true, userId: true, status: true, roles: { select: { roleCode: true } } },
});

export const revokeMembership = (tx, id, organizationId) => tx.organizationMembership.updateMany({
  where: { id, organizationId, status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] } },
  data: { status: 'REVOKED' },
});

export const revokeLegacyPharmacyStaff = async (tx, organizationId, userId) => {
  const organization = await tx.identityOrganization.findUnique({ where: { id: organizationId }, select: { pharmacyId: true } });
  if (!organization?.pharmacyId) return;
  await tx.pharmacyStaffMember.updateMany({
    where: { pharmacyId: organization.pharmacyId, pharmacistUserId: userId, status: { in: ['PENDING', 'ACTIVE'] } },
    data: { status: 'REVOKED' },
  });
};

export const auditMembership = (tx, actorId, type, membershipId, organizationId) => tx.activityLog.create({
  data: {
    userId: actorId,
    type,
    description: 'Organization membership state changed',
    meta: { membershipId, organizationId },
  },
});

export const stagePharmacyProfessional = async (tx, pharmacyId, userId) => {
  const organization = await tx.identityOrganization.findUnique({ where: { pharmacyId }, select: { id: true } });
  if (!organization) throw new Error('Identity organization migration is required');
  let membership = await tx.organizationMembership.findUnique({
    where: { userId_organizationId: { userId, organizationId: organization.id } },
    select: { id: true, status: true },
  });
  if (!membership) {
    membership = await tx.organizationMembership.create({
      data: { userId, organizationId: organization.id, status: 'PENDING' },
      select: { id: true, status: true },
    });
  } else if (membership.status === 'REVOKED') {
    membership = await tx.organizationMembership.update({
      where: { id: membership.id },
      data: { status: 'PENDING', joinedAt: null },
      select: { id: true, status: true },
    });
  }
  await tx.membershipRole.upsert({
    where: { membershipId_roleCode: { membershipId: membership.id, roleCode: 'PHARMACIST' } },
    update: {},
    create: { membershipId: membership.id, roleCode: 'PHARMACIST' },
  });
  return membership;
};

export const activatePharmacyProfessional = async (tx, pharmacyId, userId) => {
  const organization = await tx.identityOrganization.findUnique({ where: { pharmacyId }, select: { id: true } });
  if (!organization) throw new Error('Identity organization migration is required');
  await tx.organizationMembership.updateMany({
    where: { userId, organizationId: organization.id, status: 'PENDING', roles: { some: { roleCode: 'PHARMACIST' } } },
    data: { status: 'ACTIVE', joinedAt: new Date() },
  });
};
