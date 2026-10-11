import prisma from "../../config/db.js";

export const transaction = (work) => prisma.$transaction(work);

export const isPatient = (userId) =>
  prisma.userRole.findFirst({
    where: { userId, role: "PATIENT" },
    select: { id: true },
  });

export const activeReservation = (patientId, reservationId) =>
  prisma.reservation.findFirst({
    where: {
      id: reservationId,
      patientId,
      status: "ACTIVE",
      expiresAt: { gt: new Date() },
    },
    include: {
      allocations: {
        include: {
          pharmacy: {
            select: {
              id: true,
              name: true,
              address: true,
              country: true,
              state: true,
              city: true,
              latitude: true,
              longitude: true,
              complianceStatus: true,
              tier: true,
              superintendentLicenceExpiresAt: true,
              admin: { select: { accountStatus: true, emailVerifiedAt: true } },
            },
          },
          quoteItem: {
            select: { pickupAvailable: true, deliveryAvailable: true },
          },
          inventoryItem: {
            select: {
              branch: true,
              isActive: true,
              expiryDate: true,
              batchNumber: true,
              listing: {
                select: { status: true, imageHash: true, productClass: true },
              },
            },
          },
        },
      },
    },
  });
