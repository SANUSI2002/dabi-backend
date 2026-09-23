import prisma from '../../config/db.js';

const orderInclude = {
  fulfilments: {
    include: {
      pharmacy: { select: { id: true, name: true, address: true, country: true, state: true, city: true } },
      allocations: true,
    },
  },
};

export const transaction = (callback) => prisma.$transaction(callback);
export const patientRole = (tx, userId) => tx.userRole.findFirst({
  where: { userId, role: 'PATIENT' },
  select: { id: true },
});
export const isPatient = (userId) => prisma.userRole.findFirst({
  where: { userId, role: 'PATIENT' },
  select: { id: true },
});
export const existing = (tx, patientId, reservationId, idempotencyKey) => tx.order.findFirst({
  where: { patientId, OR: [{ reservationId }, { idempotencyKey }] },
  include: orderInclude,
});
export const reservation = (tx, patientId, reservationId) => tx.reservation.findFirst({
  where: { id: reservationId, patientId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
  include: {
    prescription: { select: { items: { select: { id: true, medicationName: true } } } },
    allocations: {
      include: {
        pharmacy: {
          select: {
            id: true, name: true, address: true, country: true, state: true, city: true,
            latitude: true, longitude: true, complianceStatus: true,
          },
        },
        inventoryItem: { select: { id: true, pharmacyId: true, isActive: true } },
        quoteItem: { select: { pickupAvailable: true, deliveryAvailable: true } },
      },
    },
  },
});
export const pricing = (tx) => tx.checkoutPricingConfiguration.findFirst({
  orderBy: { version: 'desc' },
  select: {
    version: true, platformFeeMinor: true, deliveryRatePerKmMinor: true, currency: true, effectiveAt: true,
  },
});
export const convertReservation = (tx, reservationId, patientId) => tx.reservation.updateMany({
  where: { id: reservationId, patientId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
  data: { status: 'CONVERTED' },
});
export const create = (tx, data) => tx.order.create({ data, include: orderInclude });
export const detail = (patientId, orderId) => prisma.order.findFirst({
  where: { id: orderId, patientId },
  include: orderInclude,
});
export const list = (patientId) => prisma.order.findMany({
  where: { patientId },
  include: orderInclude,
  orderBy: { createdAt: 'desc' },
  take: 100,
});
export const audit = (tx, userId, orderId) => tx.activityLog.create({
  data: { userId, type: 'ORDER_CREATED', description: 'Order created', meta: { orderId } },
});
