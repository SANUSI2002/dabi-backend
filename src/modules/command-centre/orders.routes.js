// /api/v1/command-centre/orders and /deliveries — every marketplace order end to end: payment
// attempts and provider events, each pharmacy's fulfilment, the delivery quote it was priced with,
// rider assignments and handover, refunds, cases and the audit trail. Delivery and pickup codes are
// never returned; the patient is shown by name and masked contact only.
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { activePartner, createAssignment } from '../delivery/delivery.repository.js';
import { adminAudit, allow, ccError, handle, maskEmail, namesFor, pageQuery, paged, rangeQuery, rangeWhere, reason } from './cc.common.js';

export const orderRoutes = express.Router();
export const deliveryRoutes = express.Router();

const none = z.object({}).strict();
const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED', 'CANCELLED'];
const FULFILMENT_STATUSES = ['AWAITING_PAYMENT', 'AWAITING_PHARMACIST_REVIEW', 'APPROVED_FOR_DISPENSING', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CLARIFICATION_REQUIRED', 'REJECTED', 'UNABLE_TO_FULFILL', 'CANCELLED'];

orderRoutes.get('/', allow('platform.ops.read', 'platform.finance.read'),
  validate(z.object({
    query: z.object({
      q: z.string().trim().max(60).optional(),
      status: z.enum(ORDER_STATUSES).optional(),
      fulfilmentStatus: z.enum(FULFILMENT_STATUSES).optional(),
      pharmacyId: z.string().uuid().optional(),
      patientId: z.string().uuid().optional(),
      method: z.enum(['DELIVERY', 'PICKUP']).optional(),
      ...rangeQuery, ...pageQuery,
    }).strict(),
    params: none,
  }).passthrough()),
  handle(async (req) => {
    const { q, status, fulfilmentStatus, pharmacyId, patientId, method, page, limit } = req.query;
    const fulfilmentFilter = { ...(fulfilmentStatus ? { status: fulfilmentStatus } : {}), ...(pharmacyId ? { pharmacyId } : {}), ...(method ? { fulfilmentMethod: method } : {}) };
    const where = {
      ...rangeWhere(req.query),
      ...(status ? { status } : {}),
      ...(patientId ? { patientId } : {}),
      ...(Object.keys(fulfilmentFilter).length ? { fulfilments: { some: fulfilmentFilter } } : {}),
      ...(q ? { OR: [{ reference: { contains: q, mode: 'insensitive' } }, { patient: { patientId: { contains: q, mode: 'insensitive' } } }, { paymentAttempts: { some: { providerReference: q } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: { patient: { select: { id: true, patientId: true, full_name: true } }, fulfilments: { select: { id: true, status: true, fulfilmentMethod: true, pharmacy: { select: { id: true, name: true } } } } } }),
      prisma.order.count({ where }),
    ]);
    return paged(rows.map((o) => ({
      id: o.id, reference: o.reference, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt,
      patient: { id: o.patient.id, patientId: o.patient.patientId, name: o.patient.full_name },
      subtotalMinor: o.subtotalMinor, deliveryFeeMinor: o.deliveryFeeMinor, platformFeeMinor: o.platformFeeMinor, totalPayableMinor: o.totalPayableMinor, pricingVersion: o.pricingConfigVersion,
      fulfilments: o.fulfilments.map((f) => ({ id: f.id, status: f.status, method: f.fulfilmentMethod, pharmacy: f.pharmacy.name, pharmacyId: f.pharmacy.id })),
    })), total, { page, limit });
  }));

/** One timeline for the order: every state change we have a timestamp for, oldest first. */
function timeline(order, audit, names) {
  const events = [{ at: order.createdAt, kind: 'ORDER', text: `Order ${order.reference} placed (pricing version ${order.pricingConfigVersion})` }];
  for (const a of order.paymentAttempts) {
    events.push({ at: a.createdAt, kind: 'PAYMENT', text: `Payment attempt started with ${a.provider} (${a.providerReference})` });
    for (const e of a.events) events.push({ at: e.createdAt, kind: 'PAYMENT', text: `Provider event ${e.eventType} → ${e.status}` });
    if (a.completedAt) events.push({ at: a.completedAt, kind: 'PAYMENT', text: `Payment attempt ${a.status.toLowerCase()}` });
  }
  for (const f of order.fulfilments) {
    const who = f.pharmacy.name;
    if (f.reviewedAt) events.push({ at: f.reviewedAt, kind: 'PHARMACY', text: `${who}: pharmacist decision recorded (${f.status.replaceAll('_', ' ').toLowerCase()})${f.reviewedByUserId ? ` by ${names.get(f.reviewedByUserId) ?? 'pharmacist'}` : ''}` });
    if (f.inventoryFinalizedAt) events.push({ at: f.inventoryFinalizedAt, kind: 'PHARMACY', text: `${who}: stock finalised` });
    for (const d of f.deliveryAssignments) {
      const rider = d.partner.displayName;
      events.push({ at: d.assignedAt, kind: 'DELIVERY', text: `${who}: assigned to rider ${rider}` });
      if (d.respondedAt) events.push({ at: d.respondedAt, kind: 'DELIVERY', text: `Rider ${rider} ${d.status === 'REJECTED' ? `declined${d.rejectionReason ? `: ${d.rejectionReason}` : ''}` : 'accepted'}` });
      if (d.pickedUpAt) events.push({ at: d.pickedUpAt, kind: 'DELIVERY', text: `Rider ${rider} collected from ${who} (pickup code confirmed)` });
      if (d.outForDeliveryAt) events.push({ at: d.outForDeliveryAt, kind: 'DELIVERY', text: `Out for delivery with ${rider}` });
      if (d.deliveredAt) events.push({ at: d.deliveredAt, kind: 'DELIVERY', text: `Delivered to the patient (delivery code confirmed)` });
    }
    if (f.refundCase) {
      const r = f.refundCase;
      events.push({ at: r.createdAt, kind: 'REFUND', text: `Refund case opened for ${who}: ${r.reason}` });
      if (r.proposedAt) events.push({ at: r.proposedAt, kind: 'REFUND', text: 'Refund proposed' });
      if (r.decidedAt) events.push({ at: r.decidedAt, kind: 'REFUND', text: `Refund ${r.status === 'DECLINED' ? 'declined' : 'approved'}` });
      if (r.submittedAt) events.push({ at: r.submittedAt, kind: 'REFUND', text: 'Refund submitted to the payment provider' });
      if (r.refundedAt) events.push({ at: r.refundedAt, kind: 'REFUND', text: 'Refund confirmed' });
    }
  }
  for (const e of audit) events.push({ at: e.createdAt, kind: 'STAFF', text: `${names.get(e.actorUserId) ?? 'Sabi staff'}: ${e.summary}` });
  return events.sort((a, b) => a.at - b.at);
}

orderRoutes.get('/:id', allow('platform.ops.read', 'platform.finance.read'),
  validate(z.object({ query: none, params: z.object({ id: z.string().min(3).max(64) }).strict() }).passthrough()),
  handle(async (req) => {
    const key = req.params.id;
    const order = await prisma.order.findFirst({
      where: /^[0-9a-f-]{36}$/i.test(key) ? { id: key } : { reference: key },
      include: {
        patient: { select: { id: true, patientId: true, full_name: true, email: true } },
        paymentAttempts: { orderBy: { createdAt: 'asc' }, select: { id: true, provider: true, providerReference: true, status: true, amountMinor: true, currency: true, expiresAt: true, completedAt: true, createdAt: true, events: { orderBy: { createdAt: 'asc' }, select: { id: true, eventType: true, status: true, createdAt: true } } } },
        fulfilments: {
          include: {
            pharmacy: { select: { id: true, name: true, city: true, state: true } },
            allocations: { select: { id: true, medicationName: true, selectedQuantity: true, unitPriceMinor: true, lineTotalMinor: true, prescriptionItemId: true } },
            refundCase: true,
            settlementItems: { where: { active: true }, select: { settlement: { select: { id: true, reference: true, status: true } } } },
            deliveryAssignments: { orderBy: { assignedAt: 'asc' }, select: { id: true, status: true, rejectionReason: true, assignedAt: true, respondedAt: true, pickedUpAt: true, outForDeliveryAt: true, deliveredAt: true, assignedByUserId: true, partner: { select: { id: true, displayName: true } }, _count: { select: { trackingPoints: true } } } },
          },
        },
      },
    });
    if (!order) throw ccError('NOT_FOUND', 404, 'Order not found.');
    const [audit, cases, webhooks] = await Promise.all([
      prisma.auditEvent.findMany({ where: { OR: [{ resourceType: 'order', resourceId: order.id }, { resourceType: 'fulfilment', resourceId: { in: order.fulfilments.map((f) => f.id) } }] }, orderBy: { createdAt: 'asc' } }),
      prisma.opsCase.findMany({ where: { orderId: order.id }, select: { id: true, reference: true, kind: true, title: true, status: true, priority: true, createdAt: true } }),
      prisma.paymentWebhookReceipt.findMany({ where: { reference: { in: order.paymentAttempts.map((a) => a.providerReference) } }, orderBy: { receivedAt: 'asc' } }),
    ]);
    const names = await namesFor(prisma, [...audit.map((e) => e.actorUserId), ...order.fulfilments.map((f) => f.reviewedByUserId)]);
    return {
      id: order.id, reference: order.reference, status: order.status, currency: order.currency, createdAt: order.createdAt, updatedAt: order.updatedAt,
      patient: { id: order.patient.id, patientId: order.patient.patientId, name: order.patient.full_name, email: maskEmail(order.patient.email) },
      money: { subtotalMinor: order.subtotalMinor, deliveryFeeMinor: order.deliveryFeeMinor, platformFeeMinor: order.platformFeeMinor, totalPayableMinor: order.totalPayableMinor, pricingVersion: order.pricingConfigVersion },
      deliveryDetailsOnFile: Boolean(order.encryptedDeliveryDetails),
      payments: order.paymentAttempts,
      webhooks,
      fulfilments: order.fulfilments.map((f) => ({
        id: f.id, pharmacy: f.pharmacy, status: f.status, method: f.fulfilmentMethod, createdAt: f.createdAt,
        subtotalMinor: f.subtotalMinor, deliveryFeeMinor: f.deliveryFeeMinor, totalMinor: f.totalMinor, commissionBps: f.commissionBps, commissionMinor: f.commissionMinor, tierVersion: f.tierVersion,
        pharmacyEarningMinor: f.commissionMinor === null ? null : f.subtotalMinor - f.commissionMinor,
        deliveryQuote: f.deliveryQuote ?? null,
        pharmacistDecision: f.reviewedAt ? { at: f.reviewedAt, by: names.get(f.reviewedByUserId) ?? null, note: f.decisionNote, messageToPatient: f.patientMessage } : null,
        lines: f.allocations,
        deliveries: f.deliveryAssignments.map((d) => ({ ...d, trackingPoints: d._count.trackingPoints, _count: undefined })),
        refund: f.refundCase,
        settlement: f.settlementItems[0]?.settlement ?? null,
      })),
      cases,
      timeline: timeline(order, audit, names),
    };
  }));

// ------------------------------------------------------------------------------------------------
// Deliveries board: every delivery fulfilment and where it stands.
// ------------------------------------------------------------------------------------------------
deliveryRoutes.get('/', allow('platform.ops.read', 'platform.delivery.manage'),
  validate(z.object({
    query: z.object({
      state: z.enum(['UNASSIGNED', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'PROBLEM']).optional(),
      partnerId: z.string().uuid().optional(),
      ...rangeQuery, ...pageQuery,
    }).strict(),
    params: none,
  }).passthrough()),
  handle(async (req) => {
    const { state, partnerId, page, limit } = req.query;
    const live = { status: { in: ['PENDING', 'ACCEPTED'] } };
    const byState = {
      UNASSIGNED: { status: 'READY_FOR_PICKUP', deliveryAssignments: { none: live } },
      ASSIGNED: { status: 'READY_FOR_PICKUP', deliveryAssignments: { some: live } },
      IN_TRANSIT: { status: 'OUT_FOR_DELIVERY' },
      DELIVERED: { status: 'DELIVERED' },
      PROBLEM: { status: { in: ['UNABLE_TO_FULFILL', 'CLARIFICATION_REQUIRED'] } },
    };
    const where = {
      fulfilmentMethod: 'DELIVERY',
      order: { status: 'PAID', ...rangeWhere(req.query) },
      ...(state ? byState[state] : { status: { notIn: ['AWAITING_PAYMENT', 'CANCELLED'] } }),
      ...(partnerId ? { deliveryAssignments: { some: { partnerId } } } : {}),
    };
    const [rows, total, partners] = await Promise.all([
      prisma.orderFulfilment.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: { order: { select: { id: true, reference: true } }, pharmacy: { select: { id: true, name: true, city: true } },
          deliveryAssignments: { orderBy: { assignedAt: 'desc' }, take: 1, select: { id: true, status: true, assignedAt: true, pickedUpAt: true, outForDeliveryAt: true, deliveredAt: true, partner: { select: { id: true, displayName: true } } } } } }),
      prisma.orderFulfilment.count({ where }),
      prisma.deliveryPartner.findMany({ orderBy: { displayName: 'asc' }, select: { id: true, displayName: true, isActive: true, _count: { select: { assignments: { where: { status: { in: ['PENDING', 'ACCEPTED'] } } } } } } }),
    ]);
    return {
      ...paged(rows.map((f) => {
        const a = f.deliveryAssignments[0] ?? null;
        return {
          fulfilmentId: f.id, order: f.order, pharmacy: f.pharmacy, status: f.status, createdAt: f.createdAt, deliveryFeeMinor: f.deliveryFeeMinor,
          distanceKm: f.deliveryQuote?.distanceKm ?? null, pricingVersion: f.deliveryQuote?.pricingVersion ?? null,
          assignment: a ? { id: a.id, status: a.status, rider: a.partner.displayName, riderId: a.partner.id, assignedAt: a.assignedAt, pickedUpAt: a.pickedUpAt, outForDeliveryAt: a.outForDeliveryAt, deliveredAt: a.deliveredAt } : null,
        };
      }), total, { page, limit }),
      riders: partners.map((p) => ({ id: p.id, name: p.displayName, active: p.isActive, openAssignments: p._count.assignments })),
    };
  }));

/**
 * Dispatch: assign a rider to a ready delivery that has no live assignment (e.g. the pharmacy has
 * not assigned one, or the rider declined). Same eligibility rules as the pharmacy's own assign.
 */
deliveryRoutes.post('/:fulfilmentId/assign', allow('platform.delivery.manage'),
  validate(z.object({ body: z.object({ partnerId: z.string().uuid(), reason }).strict(), query: none, params: z.object({ fulfilmentId: z.string().uuid() }).strict() })),
  handle(async (req, res) => {
    const result = await prisma.$transaction(async (tx) => {
      // Serialise with any concurrent assign of the same fulfilment.
      await tx.$queryRaw`SELECT "id" FROM "order_fulfilments" WHERE "id" = ${req.params.fulfilmentId} FOR UPDATE`;
      const f = await tx.orderFulfilment.findUnique({
        where: { id: req.params.fulfilmentId },
        select: { id: true, status: true, fulfilmentMethod: true, inventoryFinalizedAt: true, order: { select: { id: true, reference: true, status: true, encryptedDeliveryDetails: true } },
          deliveryAssignments: { where: { status: { in: ['PENDING', 'ACCEPTED', 'COMPLETED'] } }, select: { id: true } } },
      });
      if (!f) throw ccError('NOT_FOUND', 404, 'Fulfilment not found.');
      const blockers = [
        f.fulfilmentMethod !== 'DELIVERY' && 'This fulfilment is for pickup, not delivery.',
        f.order.status !== 'PAID' && 'The order is not paid.',
        f.status !== 'READY_FOR_PICKUP' && 'The pharmacy has not marked it ready for pickup.',
        !f.inventoryFinalizedAt && 'The pharmacy has not finalised stock for it.',
        !f.order.encryptedDeliveryDetails && 'The order has no delivery details.',
        f.deliveryAssignments.length > 0 && 'A rider is already assigned.',
      ].filter(Boolean);
      if (blockers.length) throw ccError('INVALID_STATE', 409, blockers[0], { blockers });
      const partner = await activePartner(tx, { id: req.body.partnerId });
      if (!partner) throw ccError('INVALID_STATE', 409, 'That rider is not active.');
      const assignment = await createAssignment(tx, req.user.id, f.id, partner.id);
      await adminAudit(tx, req, { summary: `Assigned rider ${partner.displayName} to order ${f.order.reference}`, resourceType: 'order', resourceId: f.order.id, reason: req.body.reason, after: { fulfilmentId: f.id, partnerId: partner.id, assignmentId: assignment.id } });
      return { id: assignment.id, status: assignment.status, assignedAt: assignment.assignedAt, rider: partner.displayName };
    });
    res.status(201);
    return result;
  }));
