import prisma from "../../config/db.js";

// Never substitute an undefined pharmacy ID: Prisma omits undefined filters.
const eligibleStaff = (userId) => ({
  pharmacistUserId: userId,
  status: "ACTIVE",
  pharmacy: {
    complianceStatus: "VERIFIED",
    OR: [
      { identityOrganization: null },
      {
        identityOrganization: {
          memberships: {
            some: {
              userId,
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
});
const scope = (userId) => ({
  pharmacy: {
    complianceStatus: "VERIFIED",
    staffMembers: { some: eligibleStaff(userId) },
  },
});
export const tx = (callback) => prisma.$transaction(callback);
export const staff = (client, userId) =>
  client.pharmacyStaffMember.findFirst({
    where: eligibleStaff(userId),
    select: { pharmacyId: true },
  });
export const queue = (userId) =>
  prisma.orderFulfilment.findMany({
    where: scope(userId),
    include: {
      order: { select: { reference: true, patientId: true } },
      allocations: true,
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
export const detail = (userId, id) =>
  prisma.orderFulfilment.findFirst({
    where: { id, ...scope(userId) },
    include: {
      order: true,
      allocations: true,
      pharmacy: {
        select: { tierLevel: true, superintendentLicenceExpiresAt: true },
      },
    },
  });
export const owned = async (client, userId, id) => {
  await client.$queryRaw`SELECT id FROM order_fulfilments WHERE id=${id} FOR UPDATE`;
  return client.orderFulfilment.findFirst({
    where: { id, status: "AWAITING_PHARMACIST_REVIEW", ...scope(userId) },
    include: {
      order: true,
      allocations: true,
      pharmacy: {
        select: { tierLevel: true, superintendentLicenceExpiresAt: true },
      },
    },
  });
};
export const update = (client, id, data) =>
  client.orderFulfilment.update({ where: { id }, data });
export const preparation = (client, userId, id, status) =>
  client.orderFulfilment.findFirst({
    where: { id, status, ...scope(userId) },
    include: {
      allocations: true,
      pharmacy: {
        select: { tierLevel: true, superintendentLicenceExpiresAt: true },
      },
    },
  });
export const transition = (client, id, from, to, finalize) =>
  client.orderFulfilment.updateMany({
    where: {
      id,
      status: from,
      ...(finalize ? { inventoryFinalizedAt: null } : {}),
    },
    data: {
      status: to,
      ...(finalize ? { inventoryFinalizedAt: new Date() } : {}),
    },
  });
export const inventory = (client, id, quantity) =>
  client.pharmacyInventoryItem.update({
    where: { id },
    data: { availableQuantity: { increment: quantity } },
  });
export const refund = (client, data) =>
  client.refundReviewCase.create({ data });
export const audit = (client, userId, type, id) =>
  client.activityLog.create({
    data: {
      userId,
      type,
      description: "Fulfilment review changed",
      meta: { id },
    },
  });
export async function stockSafe(client, fulfilment) {
  if (!fulfilment.pharmacy?.tierLevel) return true; // preserve existing untiered fulfilments
  const now = new Date();
  if (
    !fulfilment.pharmacy.superintendentLicenceExpiresAt ||
    new Date(fulfilment.pharmacy.superintendentLicenceExpiresAt) <= now
  )
    return false;
  const ids = fulfilment.allocations.map((a) => a.inventoryItemId);
  if (ids.some((id) => !id)) return false;
  for (const id of [...new Set(ids)].sort())
    await client.$queryRaw`SELECT id FROM pharmacy_inventory_items WHERE id=${id} FOR UPDATE`;
  const stock = await client.pharmacyInventoryItem.findMany({
    where: {
      id: { in: ids },
      pharmacyId: fulfilment.pharmacyId,
      isActive: true,
      branch: { status: "VERIFIED", licenceExpiresAt: { gt: now } },
    },
    select: {
      id: true,
      medicationName: true,
      genericName: true,
      batchNumber: true,
      expiryDate: true,
      listing: { select: { productClass: true } },
    },
  });
  return fulfilment.allocations.every((allocation) => {
    const row = stock.find((item) => item.id === allocation.inventoryItemId);
    if (!row) return false;
    if (
      allocation.prescriptionItemId &&
      ![row.medicationName, row.genericName]
        .filter(Boolean)
        .some(
          (name) =>
            name.toLowerCase() === allocation.medicationName.toLowerCase(),
        )
    )
      return false;
    return (
      (!allocation.prescriptionItemId &&
        row.listing?.productClass === "NON_MEDICINAL") ||
      Boolean(
        row.batchNumber && row.expiryDate && new Date(row.expiryDate) > now,
      )
    );
  });
}
