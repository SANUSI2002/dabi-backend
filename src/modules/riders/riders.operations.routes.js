import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { adminAudit, allow, ccError, handle, pageQuery, paged, reason } from '../command-centre/cc.common.js';
import { bankList } from '../payments/paystack.operations.js';
import * as ops from './riders.operations.js';
import * as money from './riders.payments.js';

const empty = z.object({}).strict(), id = z.object({ id: z.uuid() }).strict();
const point = z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), accuracyMeters: z.number().finite().min(0).max(1000) }).strict();
const body = (schema, params = empty) => validate(z.object({ body: schema, params, query: empty }));
const read = (schema = empty) => validate(z.object({ query: schema, params: empty }));
const explanation = z.string().trim().min(5).max(500).regex(/^[^\p{Cc}]+$/u);
export const riderOperationsRoutes = express.Router();
riderOperationsRoutes.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
riderOperationsRoutes.get('/availability', read(), handle((q) => ops.availability(q.user.id)));
riderOperationsRoutes.get('/offer-notifications', read(), handle(async (q) => { await ops.ownRider(prisma, q.user.id); return { items: await prisma.notification.findMany({ where: { userId: q.user.id, eventType: 'delivery.offer' }, select: { id: true, title: true, message: true, isRead: true, link: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 25 }) }; }));
riderOperationsRoutes.post('/offer-notifications/:id/read', body(empty, id), handle(async (q) => { await ops.ownRider(prisma, q.user.id); const changed = await prisma.notification.updateMany({ where: { id: q.params.id, userId: q.user.id, eventType: 'delivery.offer' }, data: { isRead: true } }); if (!changed.count) throw ccError('NOT_FOUND', 404, 'Notification not found.'); return { id: q.params.id, isRead: true }; }));
riderOperationsRoutes.put('/availability', body(z.object({ available: z.boolean(), expectedVersion: z.number().int().min(1), durationMinutes: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(240), z.literal(480)]).default(60), location: point.optional() }).strict()), handle((q) => ops.setAvailability(q.user.id, q.body)));
riderOperationsRoutes.post('/presence', body(point), handle((q) => ops.presence(q.user.id, q.body)));
riderOperationsRoutes.get('/earnings', read(z.object(pageQuery).strict()), handle((q) => money.riderEarnings(q.user.id, q.query)));
riderOperationsRoutes.get('/banks', read(), handle(async (q) => { await ops.ownRider(prisma, q.user.id); return { items: (await bankList()).filter((b) => b.active !== false).map((b) => ({ name: b.name, code: b.code })) }; }));
riderOperationsRoutes.put('/bank-account', requireRecentMfa, body(z.object({ bankCode: z.string().regex(/^\d{3,6}$/), accountNumber: z.string().regex(/^\d{10}$/), expectedRevision: z.number().int().min(0) }).strict()), handle((q) => money.saveRiderBank(q.user.id, q.body)));
riderOperationsRoutes.post('/payouts', requireRecentMfa, body(z.object({ requestKey: z.uuid(), expectedBankRevision: z.number().int().min(1) }).strict()), handle((q) => money.requestRiderPayout(q.user.id, q.body)));
riderOperationsRoutes.post('/assignments/:id/exceptions', body(z.object({ kind: z.enum(['RECIPIENT_UNAVAILABLE', 'ADDRESS_ISSUE', 'PACKAGE_DAMAGED', 'VEHICLE_BREAKDOWN', 'SAFETY_ISSUE', 'OTHER']), note: explanation }).strict(), id), handle((q) => ops.reportException(q.user.id, q.params.id, q.body)));
riderOperationsRoutes.get('/assignments/:id/exceptions', validate(z.object({ params: id, query: empty })), handle(async (q) => { const p = await ops.ownRider(prisma, q.user.id); const assignment = await prisma.deliveryAssignment.findFirst({ where: { id: q.params.id, partnerId: p.id }, select: { id: true } }); if (!assignment) throw ccError('NOT_FOUND', 404, 'Delivery not found.'); return { items: await prisma.deliveryException.findMany({ where: { assignmentId: assignment.id }, orderBy: { createdAt: 'desc' }, take: 25 }) }; }));

// Mounted beneath the existing authenticated Command Centre router.
export const riderControlRoutes = express.Router();
riderControlRoutes.get('/policy', allow('platform.ops.read', 'platform.pricing.manage', 'platform.finance.read', 'platform.delivery.manage'), read(), handle(() => prisma.riderPayPolicy.findUnique({ where: { id: 'default' } })));
riderControlRoutes.put('/policy', allow('platform.pricing.manage'), requireRecentMfa, body(z.object({ expectedVersion: z.number().int().min(1), riderShareBps: z.number().int().min(1).max(10000), published: z.boolean(), offerExpiryMinutes: z.number().int().min(5).max(60).default(15), maxOpenAssignments: z.number().int().min(1).max(10), maxPickupKm: z.number().min(0.1).max(100), automaticDispatch: z.boolean(), reason }).strict()), handle(async (q) => prisma.$transaction(async (tx) => {
  const before = await tx.riderPayPolicy.findUnique({ where: { id: 'default' } });
  const { expectedVersion, reason: why, ...data } = q.body;
  const changed = await tx.riderPayPolicy.updateMany({ where: { id: 'default', version: expectedVersion }, data: { ...data, updatedByUserId: q.user.id, version: { increment: 1 } } });
  if (!changed.count) throw ccError('VERSION_CONFLICT', 409, 'The rider policy changed. Refresh before saving.');
  await adminAudit(tx, q, { summary: 'Updated rider pay and dispatch policy', resourceType: 'rider-policy', resourceId: 'default', reason: why, before, after: data });
  return tx.riderPayPolicy.findUnique({ where: { id: 'default' } });
})));
riderControlRoutes.get('/riders', allow('platform.ops.read', 'platform.delivery.manage'), read(z.object(pageQuery).strict()), handle(async (q) => {
  const { page, limit } = q.query;
  const [rows, total] = await Promise.all([prisma.deliveryPartner.findMany({ take: limit, skip: (page - 1) * limit, orderBy: { displayName: 'asc' }, select: { id: true, displayName: true, isActive: true, isAvailable: true, availableUntil: true, locationUpdatedAt: true, user: { select: { riderApplication: { select: { status: true, licenceExpiresAt: true, insuranceExpiresAt: true } } } }, _count: { select: { assignments: { where: { status: { in: ['PENDING', 'ACCEPTED'] } } } } } } }), prisma.deliveryPartner.count()]);
  return paged(rows.map((r) => ({ id: r.id, name: r.displayName, active: r.isActive, online: r.isAvailable && r.availableUntil > new Date(), availableUntil: r.availableUntil, locationUpdatedAt: r.locationUpdatedAt, openAssignments: r._count.assignments, credentials: r.user.riderApplication })), total, { page, limit });
}));
riderControlRoutes.post('/dispatch/:id', allow('platform.delivery.manage'), requireRecentMfa, body(z.object({ reason }).strict(), id), handle(async (q) => { const result = await ops.dispatchOne(q.params.id, q.user.id); await adminAudit(prisma, q, { summary: 'Dispatched nearest eligible rider', resourceType: 'delivery-assignment', resourceId: result.id, reason: q.body.reason }); return result; }));
riderControlRoutes.get('/exceptions', allow('platform.ops.read', 'platform.delivery.manage'), read(z.object({ ...pageQuery, status: z.enum(['OPEN', 'RESOLVED']).default('OPEN') }).strict()), handle(async (q) => {
  const { page, limit, status } = q.query; const where = { status };
  const [items, total] = await Promise.all([prisma.deliveryException.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' }, include: { assignment: { select: { id: true, status: true, partner: { select: { displayName: true } }, fulfilment: { select: { status: true, order: { select: { reference: true } } } } } } } }), prisma.deliveryException.count({ where })]);
  return paged(items, total, { page, limit });
}));
riderControlRoutes.post('/exceptions/:id/resolve', allow('platform.delivery.manage'), requireRecentMfa, body(z.object({ expectedVersion: z.number().int().min(1), resolution: z.enum(['REATTEMPT', 'CONTACTED_RECIPIENT', 'RETURN_ARRANGED', 'RESOLVED_BY_SUPPORT']), reason }).strict(), id), handle((q) => ops.resolveException(q, q.params.id, q.body)));
riderControlRoutes.get('/payouts', allow('platform.finance.read', 'platform.finance.manage', 'platform.finance.approve'), read(z.object({ ...pageQuery, status: z.enum(['REQUESTED', 'APPROVED', 'SUBMITTED', 'PAID', 'FAILED', 'REVERSED', 'NEEDS_PROVIDER_AUTH', 'UNKNOWN']).optional() }).strict()), handle(async (q) => {
  const { page, limit, status } = q.query; const where = status ? { status } : {};
  const [items, total] = await Promise.all([prisma.riderPayout.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' }, select: { id: true, reference: true, amountMinor: true, currency: true, status: true, accountLast4: true, createdAt: true, approvedAt: true, paidAt: true, providerErrorCode: true, requestedByUserId: true, partner: { select: { displayName: true } }, attempts: { select: { number: true, reference: true, status: true, errorCode: true, createdAt: true }, orderBy: { number: 'desc' } } } }), prisma.riderPayout.count({ where })]);
  return paged(items, total, { page, limit });
}));
riderControlRoutes.post('/payouts/:id/approve', allow('platform.finance.approve'), requireRecentMfa, body(z.object({ reason }).strict(), id), handle((q) => money.approveRiderPayout(q, q.params.id, q.body.reason)));
riderControlRoutes.post('/payouts/:id/submit', allow('platform.finance.manage'), requireRecentMfa, body(z.object({ reason }).strict(), id), handle((q) => money.submitRiderPayout(q, q.params.id, q.body.reason)));
riderControlRoutes.post('/payouts/:id/reconcile', allow('platform.finance.manage'), requireRecentMfa, body(z.object({ reason }).strict(), id), handle(async (q) => { const attempt = await prisma.riderTransferAttempt.findFirst({ where: { payoutId: q.params.id }, orderBy: { number: 'desc' } }); if (!attempt) throw ccError('NOT_FOUND', 404, 'No transfer has been submitted for this payout.'); const result = await money.reconcileRiderTransfer(attempt.reference); await adminAudit(prisma, q, { summary: 'Reconciled rider transfer', resourceType: 'rider-payout', resourceId: q.params.id, reason: q.body.reason }); return result; }));
riderControlRoutes.post('/payouts/:id/authorise', allow('platform.finance.manage'), requireRecentMfa, body(z.object({ otp: z.string().regex(/^\d{6}$/), reason }).strict(), id), handle((q) => money.finalizeRiderPayout(q, q.params.id, q.body.otp, q.body.reason)));
