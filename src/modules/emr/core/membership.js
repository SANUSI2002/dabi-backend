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
