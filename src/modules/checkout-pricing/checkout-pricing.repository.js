import prisma from '../../config/db.js';

const pricingSelect = {
  id: true,
  version: true,
  platformFeeMinor: true,
  deliveryRatePerKmMinor: true,
  currency: true,
  effectiveAt: true,
  createdAt: true,
};

export const currentConfiguration = () => prisma.checkoutPricingConfiguration.findFirst({
  orderBy: { version: 'desc' },
  select: pricingSelect,
});

export const isSuperAdmin = (userId) => prisma.userRole.findFirst({
  where: { userId, role: 'SUPER_ADMIN' },
  select: { id: true },
});

export const isPatient = (userId) => prisma.userRole.findFirst({
  where: { userId, role: 'PATIENT' },
  select: { id: true },
});

export const createConfiguration = (userId, values) => prisma.$transaction(async (tx) => {
  const current = await tx.checkoutPricingConfiguration.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  return tx.checkoutPricingConfiguration.create({
    data: {
      ...values,
      version: (current?.version ?? 0) + 1,
      effectiveAt: new Date(),
      createdByUserId: userId,
    },
    select: pricingSelect,
  });
});

export const activeReservation = (patientId, reservationId) => prisma.reservation.findFirst({
  where: {
    id: reservationId,
    patientId,
    status: 'ACTIVE',
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
          },
        },
        quoteItem: {
          select: { pickupAvailable: true, deliveryAvailable: true },
        },
      },
    },
  },
});
