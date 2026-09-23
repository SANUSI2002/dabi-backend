import prisma from '../../config/db.js';

// Serializable reads/writes protect assignment, activation and transition races.
export const transaction = (work) => prisma.$transaction(work, { isolationLevel: 'Serializable' });
export const role = (tx, userId, role) => tx.userRole.findFirst({ where: { userId, role }, select: { id: true } });
export const partnerSelect = { id: true, userId: true, displayName: true, isActive: true };
export const activePartner = (tx, where) => tx.deliveryPartner.findFirst({
  where: { ...where, isActive: true, user: { roles: { some: { role: 'DELIVERY_PARTNER' } } } }, select: partnerSelect,
});
export const configure = async (tx, actorId, userId, data) => {
  if (!await tx.user.findUnique({ where: { id: userId }, select: { id: true } })) return null;
  await tx.userRole.upsert({ where: { userId_role: { userId, role: 'DELIVERY_PARTNER' } },
    create: { userId, role: 'DELIVERY_PARTNER' }, update: {} });
  return tx.deliveryPartner.upsert({ where: { userId },
    create: { userId, ...data, configuredByUserId: actorId },
    update: { ...data, configuredByUserId: actorId }, select: partnerSelect });
};
export const partners = (tx, { limit, offset }) => tx.deliveryPartner.findMany({
  where: { isActive: true, user: { roles: { some: { role: 'DELIVERY_PARTNER' } } } },
  select: { id: true, displayName: true }, orderBy: { id: 'asc' }, take: limit, skip: offset,
});
export const assignable = (tx, actorId, id) => tx.orderFulfilment.findFirst({
  where: { id, pharmacy: { adminUserId: actorId } },
  select: { id: true, status: true, fulfilmentMethod: true, inventoryFinalizedAt: true,
    order: { select: { status: true, encryptedDeliveryDetails: true } },
    deliveryAssignments: { where: { status: { in: ['PENDING', 'ACCEPTED', 'COMPLETED'] } }, select: { id: true } },
  },
});
const assignmentSelect = {
  id: true, fulfilmentId: true, status: true, assignedAt: true, respondedAt: true,
  pickedUpAt: true, outForDeliveryAt: true, deliveredAt: true,
};
const pickupSelect = { id: true, name: true, address: true, contactPhone: true };
export const createAssignment = (tx, actorId, fulfilmentId, partnerId) => tx.deliveryAssignment.create({
  data: { fulfilmentId, partnerId, assignedByUserId: actorId }, select: assignmentSelect,
});
export const assignments = (tx, partnerId, { limit, offset }) => tx.deliveryAssignment.findMany({
  where: { partnerId, status: { in: ['PENDING', 'ACCEPTED'] } },
  select: { ...assignmentSelect, fulfilment: { select: {
    status: true, pharmacy: { select: pickupSelect }, order: { select: { reference: true } },
  } } }, orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }], take: limit, skip: offset,
});
export const assigned = (tx, partnerId, id) => tx.deliveryAssignment.findFirst({
  where: { id, partnerId, status: { in: ['PENDING', 'ACCEPTED', 'COMPLETED'] } },
  select: { ...assignmentSelect, fulfilment: { select: {
    id: true, status: true, pharmacy: { select: pickupSelect },
    order: { select: { reference: true, encryptedDeliveryDetails: true } },
  } } },
});
export const changeAssignment = (tx, id, status, data) => tx.deliveryAssignment.updateMany({ where: { id, status }, data });
export const changeFulfilment = (tx, id, status, next) => tx.orderFulfilment.updateMany({ where: { id, status }, data: { status: next } });
export const addLocation = (tx, assignmentId, data) => tx.deliveryTrackingPoint.create({
  data: { assignmentId, ...data }, select: { id: true, latitude: true, longitude: true, recordedAt: true },
});
export const patientOrder = (tx, patientId, id) => tx.order.findFirst({
  where: { id, patientId }, select: { id: true, reference: true, status: true,
    fulfilments: { orderBy: { id: 'asc' }, select: {
      id: true, status: true, fulfilmentMethod: true, pharmacy: { select: { id: true, name: true } },
      deliveryAssignments: { where: { status: { in: ['PENDING', 'ACCEPTED', 'COMPLETED'] } },
        select: { ...assignmentSelect, trackingPoints: {
          orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: 100,
          select: { latitude: true, longitude: true, recordedAt: true },
        } },
      },
    } },
  },
});
export const audit = (tx, userId, type, id) => tx.activityLog.create({ data: {
  userId, type, description: 'Delivery operation', meta: { id },
} });
