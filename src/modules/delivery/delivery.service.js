import * as r from './delivery.repository.js';
import { decryptDeliveryDetails } from '../orders/orders.delivery.js';

const fail = (code) => Object.assign(new Error(code), { code });
const requireRole = async (tx, userId, role) => {
  if (!await r.role(tx, userId, role)) throw fail('FORBIDDEN');
};
const partner = async (tx, userId) => {
  const result = await r.activePartner(tx, { userId });
  if (!result) throw fail('FORBIDDEN');
  return result;
};
const owned = async (tx, userId, id) => {
  const profile = await partner(tx, userId);
  const assignment = await r.assigned(tx, profile.id, id);
  if (!assignment) throw fail('NOT_FOUND');
  return assignment;
};
const changed = (result) => { if (result.count !== 1) throw fail('CONFLICT'); };
export const configure = (actorId, userId, data) => r.transaction(async (tx) => {
  await requireRole(tx, actorId, 'SUPER_ADMIN');
  const result = await r.configure(tx, actorId, userId, data);
  if (!result) throw fail('NOT_FOUND');
  await r.audit(tx, actorId, 'DELIVERY_PARTNER_CONFIGURED', result.id);
  return result;
});
export const partners = (userId, page) => r.transaction(async (tx) => {
  await requireRole(tx, userId, 'PHARMACY_ADMIN');
  return r.partners(tx, page);
});
export const assign = (userId, id, { partnerId }) => r.transaction(async (tx) => {
  await requireRole(tx, userId, 'PHARMACY_ADMIN');
  const f = await r.assignable(tx, userId, id);
  if (!f) throw fail('NOT_FOUND');
  if (f.status !== 'READY_FOR_PICKUP' || f.fulfilmentMethod !== 'DELIVERY' ||
      !f.inventoryFinalizedAt || f.order.status !== 'PAID' || !f.order.encryptedDeliveryDetails ||
      f.deliveryAssignments.length) throw fail('CONFLICT');
  if (!await r.activePartner(tx, { id: partnerId })) throw fail('CONFLICT');
  const result = await r.createAssignment(tx, userId, id, partnerId);
  await r.audit(tx, userId, 'DELIVERY_ASSIGNED', result.id);
  return result;
});
const summary = (a) => ({
  id: a.id, fulfilmentId: a.fulfilmentId, assignmentStatus: a.status,
  fulfilmentStatus: a.fulfilment.status, reference: a.fulfilment.order.reference,
  pickup: a.fulfilment.pharmacy, assignedAt: a.assignedAt, respondedAt: a.respondedAt,
  pickedUpAt: a.pickedUpAt, outForDeliveryAt: a.outForDeliveryAt, deliveredAt: a.deliveredAt,
});
export const queue = (userId, page) => r.transaction(async (tx) => {
  const profile = await partner(tx, userId);
  return (await r.assignments(tx, profile.id, page)).map(summary);
});
export const detail = (userId, id) => r.transaction(async (tx) => {
  const a = await owned(tx, userId, id);
  // Completed assignments retain status history but no longer disclose recipient PII.
  return { ...summary(a), ...(a.status === 'COMPLETED' ? {} : {
    recipient: decryptDeliveryDetails(a.fulfilment.order.encryptedDeliveryDetails),
  }) };
});
export const respond = (userId, id, reason) => r.transaction(async (tx) => {
  const a = await owned(tx, userId, id);
  if (a.status !== 'PENDING' || a.fulfilment.status !== 'READY_FOR_PICKUP') throw fail('CONFLICT');
  const status = reason === undefined ? 'ACCEPTED' : 'REJECTED';
  changed(await r.changeAssignment(tx, id, 'PENDING', {
    status, respondedAt: new Date(), ...(reason === undefined ? {} : { rejectionReason: reason }),
  }));
  // Rejection releases assignment only. Fulfilment remains ready; stock stays committed.
  await r.audit(tx, userId, `DELIVERY_ASSIGNMENT_${status}`, id);
  return { id, assignmentStatus: status, fulfilmentStatus: 'READY_FOR_PICKUP' };
});
const flow = {
  PICKED_UP: ['READY_FOR_PICKUP', 'pickedUpAt'],
  OUT_FOR_DELIVERY: ['PICKED_UP', 'outForDeliveryAt'],
  DELIVERED: ['OUT_FOR_DELIVERY', 'deliveredAt'],
};
export const transition = (userId, id, { status }) => r.transaction(async (tx) => {
  const a = await owned(tx, userId, id);
  const [from, timestamp] = flow[status];
  if (a.status !== 'ACCEPTED' || a.fulfilment.status !== from) throw fail('CONFLICT');
  changed(await r.changeFulfilment(tx, a.fulfilmentId, from, status));
  changed(await r.changeAssignment(tx, id, 'ACCEPTED', {
    [timestamp]: new Date(), ...(status === 'DELIVERED' ? { status: 'COMPLETED' } : {}),
  }));
  await r.audit(tx, userId, `DELIVERY_${status}`, id);
  return { id, assignmentStatus: status === 'DELIVERED' ? 'COMPLETED' : 'ACCEPTED', fulfilmentStatus: status };
});
export const location = (userId, id, data) => r.transaction(async (tx) => {
  const a = await owned(tx, userId, id);
  if (a.status !== 'ACCEPTED' || !['PICKED_UP', 'OUT_FOR_DELIVERY'].includes(a.fulfilment.status)) throw fail('CONFLICT');
  const result = await r.addLocation(tx, id, data);
  await r.audit(tx, userId, 'DELIVERY_LOCATION_RECORDED', id);
  return result;
});
// Keep the order's payment status intact and derive a separate aggregate tracking status.
export const trackingStatus = (fulfilments) => {
  const statuses = fulfilments.map((f) => f.status);
  if (statuses.length && statuses.every((s) => s === 'DELIVERED')) return 'DELIVERED';
  if (statuses.some((s) => s === 'DELIVERED')) return 'PARTIALLY_DELIVERED';
  if (statuses.some((s) => ['PICKED_UP', 'OUT_FOR_DELIVERY'].includes(s))) return 'IN_DELIVERY';
  if (statuses.length && statuses.every((s) => s === 'READY_FOR_PICKUP')) return 'READY_FOR_PICKUP';
  if (statuses.some((s) => ['CLARIFICATION_REQUIRED', 'REJECTED', 'UNABLE_TO_FULFILL'].includes(s))) return 'ACTION_REQUIRED';
  if (statuses.length && statuses.every((s) => s === 'CANCELLED')) return 'CANCELLED';
  return 'PROCESSING';
};
export const tracking = (userId, id) => r.transaction(async (tx) => {
  await requireRole(tx, userId, 'PATIENT');
  const order = await r.patientOrder(tx, userId, id);
  if (!order) throw fail('NOT_FOUND');
  return { ...order, trackingStatus: trackingStatus(order.fulfilments) };
});
