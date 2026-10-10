const fail = (code) => Object.assign(new Error(code), { code });
export const owner = async (tx, u) => {
  const role = await tx.userRole.findFirst({
    where: { userId: u, role: "PHARMACY_ADMIN" },
    select: { id: true },
  });
  const p =
    role &&
    (await tx.pharmacy.findFirst({
      where: { adminUserId: u, complianceStatus: "VERIFIED" },
      select: { id: true },
    }));
  if (!p) throw fail("NOT_FOUND");
  return p;
};
export const staff = async (tx, u, pharmacyId) => {
  const s = await tx.pharmacyStaffMember.findFirst({
    where: {
      pharmacistUserId: u,
      ...(pharmacyId ? { pharmacyId } : {}),
      status: "ACTIVE",
      pharmacy: {
        complianceStatus: "VERIFIED",
        OR: [
          { identityOrganization: null },
          {
            identityOrganization: {
              memberships: {
                some: {
                  userId: u,
                  status: "ACTIVE",
                  roles: { some: { roleCode: "PHARMACIST" } },
                },
              },
            },
          },
        ],
      },
      pharmacist: {
        accountStatus: "ACTIVE",
        professionalProfile: {
          professionType: "PHARMACIST",
          verificationStatus: "VERIFIED",
        },
      },
    },
    select: { id: true, pharmacyId: true },
  });
  if (!s) throw fail("NOT_FOUND");
  return s;
};
export const error = fail;
