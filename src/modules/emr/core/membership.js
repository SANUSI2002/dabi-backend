// Checks about OTHER members of the caller's organization (e.g. a controlled-drug witness).
// Memberships and roles are identity tables, not EMR tables, so this runs outside withTenant.
import prisma from '../../../config/db.js';

/** True when the user has an ACTIVE membership in the organization with a role granting `permission`. */
export async function activeMemberWithPermission(organizationId, userId, permission) {
  const membership = await prisma.organizationMembership.findFirst({
    where: {
      userId, organizationId, status: 'ACTIVE',
      user: { accountStatus: 'ACTIVE' },
      roles: { some: { role: { permissions: { some: { permissionCode: permission } } } } },
    },
    select: { id: true },
  });
  return !!membership;
}

/** Active colleagues whose role grants `permission`, as { userId, name }, by name. Names only. */
export async function activeMembersWithPermission(organizationId, permission) {
  const memberships = await prisma.organizationMembership.findMany({
    where: {
      organizationId, status: 'ACTIVE',
      user: { accountStatus: 'ACTIVE' },
      roles: { some: { role: { permissions: { some: { permissionCode: permission } } } } },
    },
    select: { user: { select: { id: true, full_name: true } } },
  });
  return memberships
    .map(({ user }) => ({ userId: user.id, name: user.full_name }))
    .sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''));
}

/** True when the user has an ACTIVE membership in the organization holding `roleCode`. */
export async function activeMemberWithRole(organizationId, userId, roleCode) {
  const membership = await prisma.organizationMembership.findFirst({
    where: { userId, organizationId, status: 'ACTIVE', user: { accountStatus: 'ACTIVE' }, roles: { some: { roleCode } } },
    select: { id: true },
  });
  return !!membership;
}

/** userId → role codes held in the organization (any membership status), for labelling audit actors. */
export async function memberRoleMap(organizationId, userIds) {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return new Map();
  const memberships = await prisma.organizationMembership.findMany({
    where: { organizationId, userId: { in: unique } },
    select: { userId: true, roles: { select: { roleCode: true } } },
  });
  return new Map(memberships.map((m) => [m.userId, m.roles.map((r) => r.roleCode).sort()]));
}
