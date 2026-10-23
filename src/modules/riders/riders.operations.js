import { randomUUID } from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';
import prisma from '../../config/db.js';
import { activePartner, createAssignment, audit as deliveryAudit } from '../delivery/delivery.repository.js';
import { adminAudit, ccError } from '../command-centre/cc.common.js';

const error = (code, status, message) => ccError(code, status, message);
export async function ownRider(tx, userId) {
  const profile = await activePartner(tx, { userId });
  if (!profile) throw error('RIDER_ACCESS_REQUIRED', 403, 'Your active rider account is required. Check your application or contact Sabi operations.');
  return profile;
}
export async function availability(userId, db = prisma) {
  const profile = await ownRider(db, userId);
  const row = await db.deliveryPartner.findUnique({ where: { id: profile.id }, select: { isAvailable: true, availableUntil: true, availabilityVersion: true, locationUpdatedAt: true } });
  return { ...row, isAvailable: row.isAvailable && row.availableUntil > new Date(), locationFresh: Boolean(row.locationUpdatedAt && Date.now() - row.locationUpdatedAt < 300000) };
}
export async function setAvailability(userId, data, db = prisma) {
  return db.$transaction(async (tx) => {
    const profile = await ownRider(tx, userId), now = new Date();
    const changed = await tx.deliveryPartner.updateMany({ where: { id: profile.id, availabilityVersion: data.expectedVersion }, data: {
      isAvailable: data.available, availableUntil: data.available ? new Date(now.getTime() + data.durationMinutes * 60000) : null,
      availabilityVersion: { increment: 1 },
      ...(data.location ? { lastLatitude: data.location.latitude, lastLongitude: data.location.longitude, locationAccuracyMeters: data.location.accuracyMeters, locationUpdatedAt: now } : {}),
    } });
    if (!changed.count) throw error('VERSION_CONFLICT', 409, 'Your availability changed in another tab. Refresh before trying again.');
    await deliveryAudit(tx, userId, data.available ? 'RIDER_ONLINE' : 'RIDER_OFFLINE', profile.id);
    return availability(userId, tx);
  });
}
export async function presence(userId, location, db = prisma) {
  const profile = await ownRider(db, userId), now = new Date();
  const changed = await db.deliveryPartner.updateMany({ where: { id: profile.id, isAvailable: true, availableUntil: { gt: now } }, data: { lastLatitude: location.latitude, lastLongitude: location.longitude, locationAccuracyMeters: location.accuracyMeters, locationUpdatedAt: now } });
  if (!changed.count) throw error('RIDER_OFFLINE', 409, 'Go online before sharing your dispatch location.');
  return { recordedAt: now };
}
export function pickupDistanceKm(a, b) {
  const rad = (d) => d * Math.PI / 180, dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2)), Math.sqrt(Math.max(0, 1 - (Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2))));
}
export async function dispatchOne(fulfilmentId, actorId, { db = prisma, requireAutomatic = false } = {}) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM order_fulfilments WHERE id = ${fulfilmentId} FOR UPDATE`;
    const f = await tx.orderFulfilment.findUnique({ where: { id: fulfilmentId }, include: { order: { select: { status: true, encryptedDeliveryDetails: true } }, pharmacy: { select: { latitude: true, longitude: true } } } });
    if (!f || f.fulfilmentMethod !== 'DELIVERY' || f.status !== 'READY_FOR_PICKUP' || f.order.status !== 'PAID' || !f.inventoryFinalizedAt || !f.order.encryptedDeliveryDetails) throw error('DISPATCH_NOT_READY', 409, 'Only a paid delivery with finalised stock and delivery details can be dispatched.');
    const policy = await tx.riderPayPolicy.findUnique({ where: { id: 'default' } });
    if (!policy?.published || (requireAutomatic && !policy.automaticDispatch)) throw error('DISPATCH_POLICY_REQUIRED', 409, 'Publish a rider pay and dispatch policy before using automatic dispatch.');
    const pickup = f.deliveryQuote?.pickup;
    if (!pickup || !Number.isFinite(pickup.latitude) || !Number.isFinite(pickup.longitude)) throw error('PICKUP_LOCATION_REQUIRED', 409, 'This order needs a frozen branch pickup location before nearby dispatch. Choose a rider manually for older orders.');
    if (await tx.deliveryAssignment.count({ where: { fulfilmentId, status: { not: 'REJECTED' } } })) throw error('ALREADY_ASSIGNED', 409, 'This delivery already has a rider.');
    const now = new Date();
    const candidates = await tx.deliveryPartner.findMany({ where: { isActive: true, isAvailable: true, availableUntil: { gt: now }, locationUpdatedAt: { gt: new Date(now.getTime() - 300000) }, locationAccuracyMeters: { lte: 1000 }, lastLatitude: { not: null }, lastLongitude: { not: null } }, take: 200, orderBy: { locationUpdatedAt: 'desc' } });
    const rejected = await tx.deliveryAssignment.findMany({ where: { fulfilmentId, status: 'REJECTED' }, select: { partnerId: true } });
    const skipped = new Set(rejected.map((a) => a.partnerId));
    const nearby = candidates.filter((p) => !skipped.has(p.id)).map((p) => ({ ...p, km: pickupDistanceKm(pickup, { latitude: p.lastLatitude, longitude: p.lastLongitude }) })).filter((p) => p.km <= policy.maxPickupKm).sort((a, b) => a.km - b.km || a.id.localeCompare(b.id));
    for (const candidate of nearby) {
      await tx.$queryRaw`SELECT id FROM delivery_partners WHERE id = ${candidate.id} FOR UPDATE`;
      const active = await activePartner(tx, { id: candidate.id });
      const current = await tx.deliveryPartner.findUnique({ where: { id: candidate.id } });
      if (!active || !current.isAvailable || current.availableUntil <= now || !current.locationUpdatedAt || current.locationUpdatedAt < new Date(now.getTime() - 300000)) continue;
      const open = await tx.deliveryAssignment.count({ where: { partnerId: candidate.id, status: { in: ['PENDING', 'ACCEPTED'] } } });
      if (open >= policy.maxOpenAssignments) continue;
      const dispatcherId = actorId || policy.updatedByUserId;
      if (!dispatcherId) throw error('DISPATCH_POLICY_REQUIRED', 409, 'An authorised operator must publish the dispatch policy first.');
      const result = await createAssignment(tx, dispatcherId, f.id, candidate.id);
      await deliveryAudit(tx, dispatcherId, actorId ? 'DELIVERY_AUTO_DISPATCHED' : 'DELIVERY_SYSTEM_DISPATCHED', result.id);
      return { id: result.id, rider: active.displayName, pickupDistanceKm: Math.round(candidate.km * 100) / 100, distanceMethod: 'STRAIGHT_LINE', earningOfferMinor: result.earningOfferMinor };
    }
    throw error('NO_AVAILABLE_RIDER', 409, 'No eligible online rider is nearby. The delivery remains unassigned; retry or choose a rider manually.');
  });
}
export async function reportException(userId, assignmentId, data, db = prisma) {
  return db.$transaction(async (tx) => {
    const profile = await ownRider(tx, userId);
    await tx.$queryRaw`SELECT id FROM delivery_assignments WHERE id = ${assignmentId} FOR UPDATE`;
    const assigned = await tx.deliveryAssignment.findFirst({ where: { id: assignmentId, partnerId: profile.id, status: 'ACCEPTED' } });
    if (!assigned) throw error('NOT_FOUND', 404, 'Active delivery not found.');
    const prior = await tx.deliveryException.findFirst({ where: { assignmentId, status: 'OPEN' } });
    if (prior) return prior;
    const issue = await tx.deliveryException.create({ data: { assignmentId, kind: data.kind, note: data.note, reportedByUserId: userId } });
    await deliveryAudit(tx, userId, 'DELIVERY_EXCEPTION_REPORTED', issue.id);
    return issue;
  });
}
export async function resolveException(req, id, data, db = prisma) {
  return db.$transaction(async (tx) => {
    const before = await tx.deliveryException.findUnique({ where: { id } });
    if (!before) throw error('NOT_FOUND', 404, 'Delivery issue not found.');
    const changed = await tx.deliveryException.updateMany({ where: { id, status: 'OPEN', version: data.expectedVersion }, data: { status: 'RESOLVED', resolution: data.resolution, resolutionNote: data.reason, resolvedByUserId: req.user.id, resolvedAt: new Date(), version: { increment: 1 } } });
    if (!changed.count) throw error('VERSION_CONFLICT', 409, 'This issue was updated. Refresh to see the latest decision.');
    await adminAudit(tx, req, { summary: 'Resolved delivery exception', resourceType: 'delivery-exception', resourceId: id, reason: data.reason, after: { resolution: data.resolution } });
    return { id, status: 'RESOLVED' };
  });
}
export async function earnDelivery(tx, assignment) {
  if (!assignment.earningOfferMinor || !assignment.payPolicyVersion) return null;
  // The immutable earning and delivery confirmation commit together. Replays cannot double-credit.
  return tx.riderEarning.create({ data: { id: randomUUID(), assignmentId: assignment.id, partnerId: assignment.partnerId, amountMinor: assignment.earningOfferMinor, policyVersion: assignment.payPolicyVersion } });
}
export async function runAutoDispatchOnce({ db = prisma, dispatch = dispatchOne } = {}) {
  if (process.env.RIDER_AUTO_DISPATCH_WORKER === 'false') return 0;
  await expireRiderOffers(db);
  const policy = await db.riderPayPolicy.findUnique({ where: { id: 'default' } });
  if (!policy?.published || !policy.automaticDispatch) return 0;
  const due = await db.orderFulfilment.findMany({ where: { status: 'READY_FOR_PICKUP', fulfilmentMethod: 'DELIVERY', order: { status: 'PAID' }, deliveryAssignments: { none: { status: { not: 'REJECTED' } } } }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: 10 });
  for (const fulfilment of due) try { await dispatch(fulfilment.id, null, { db, requireAutomatic: true }); } catch (e) { if (!e.ccError) throw e; }
  return due.length;
}
export function startAutoDispatchWorker() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || process.env.RIDER_AUTO_DISPATCH_WORKER === 'false') return;
    busy = true;
    try {
      await runAutoDispatchOnce();
    } catch { console.error('[rider-dispatch] Queue unavailable; deliveries remain unassigned.'); }
    finally { busy = false; }
  }, 15000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function expireRiderOffers(db = prisma, now = new Date()) {
  const rows = await db.deliveryAssignment.findMany({ where: { status: 'PENDING', offerExpiresAt: { lte: now } }, select: { id: true, fulfilmentId: true, assignedByUserId: true }, take: 50 });
  for (const row of rows) await db.$transaction(async (tx) => {
    // Same lock order as dispatch; expiry never changes stock or paid fulfilment state.
    await tx.$queryRaw`SELECT id FROM order_fulfilments WHERE id = ${row.fulfilmentId} FOR UPDATE`;
    const changed = await tx.deliveryAssignment.updateMany({ where: { id: row.id, status: 'PENDING', offerExpiresAt: { lte: now } }, data: { status: 'REJECTED', rejectionReason: 'Offer expired without a response', respondedAt: now, pickupCodeEncrypted: null, deliveryCodeEncrypted: null } });
    if (changed.count) await deliveryAudit(tx, row.assignedByUserId, 'DELIVERY_OFFER_EXPIRED', row.id);
  });
  return rows.length;
}
