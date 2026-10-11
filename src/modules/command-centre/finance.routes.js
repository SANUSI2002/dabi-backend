// /api/v1/command-centre/finance — money in and out: revenue breakdown, payment attempts, provider
// webhooks, reconciliation checks, refunds (maker-checker, provider evidence) and pharmacy
// settlements (prepared, approved by another person, paid by recorded bank transfer).
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { configured as paystackConfigured } from '../payments/paystack.adapter.js';
import { allow, ccError, handle, namesFor, pageQuery, paged, rangeQuery, rangeWhere, reason } from './cc.common.js';
import * as finance from './finance.service.js';
import { period } from './overview.routes.js';

export const financeRoutes = express.Router();

const none = z.object({}).strict();
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid }).strict();
const READ = ['platform.finance.read', 'platform.finance.manage', 'platform.finance.approve'];

// ------------------------------------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------------------------------------
financeRoutes.get('/summary', allow(...READ),
  validate(z.object({ query: z.object({ ...rangeQuery, tz: z.string().max(64).optional() }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const { from, to, tz } = period(req.query);
    const paidInRange = { status: 'PAID', createdAt: { gte: from, lt: to } };
    const [orders, fulfilments, refunds, settlements, unsettled] = await Promise.all([
      prisma.order.aggregate({ where: paidInRange, _sum: { totalPayableMinor: true, subtotalMinor: true, deliveryFeeMinor: true, platformFeeMinor: true }, _count: { _all: true } }),
      prisma.orderFulfilment.aggregate({ where: { order: paidInRange }, _sum: { commissionMinor: true, subtotalMinor: true } }),
      prisma.refundReviewCase.groupBy({ by: ['status'], where: { createdAt: { gte: from, lt: to } }, _sum: { amountMinor: true }, _count: { _all: true } }),
      prisma.pharmacySettlement.groupBy({ by: ['status'], where: { createdAt: { gte: from, lt: to } }, _sum: { netPayableMinor: true }, _count: { _all: true } }),
      prisma.orderFulfilment.aggregate({ where: { status: { in: ['DELIVERED', 'PICKED_UP'] }, order: { status: 'PAID' }, commissionMinor: { not: null }, settlementItems: { none: { active: true } } }, _sum: { subtotalMinor: true, commissionMinor: true }, _count: { _all: true } }),
    ]);
    const commission = fulfilments._sum.commissionMinor ?? 0;
    const fold = (rows) => Object.fromEntries(rows.map((r) => [r.status, { count: r._count._all, amountMinor: r._sum.amountMinor ?? r._sum.netPayableMinor ?? 0 }]));
    return {
      period: { from: from.toISOString(), to: to.toISOString(), timeZone: tz },
      generatedAt: new Date().toISOString(),
      definitions: {
        collected: 'Total paid by patients for orders created in the period (confirmed by the payment provider).',
        sabiRevenue: 'Commission + delivery fees + platform fees on those orders.',
        pharmacyEarnings: 'Medicines subtotal less commission on those orders (owed to pharmacies once handed over).',
        unsettled: 'All-time pharmacy earnings on handed-over fulfilments not yet on a live settlement.',
      },
      collected: { count: orders._count._all, amountMinor: orders._sum.totalPayableMinor ?? 0 },
      breakdown: {
        medicinesMinor: orders._sum.subtotalMinor ?? 0, deliveryFeesMinor: orders._sum.deliveryFeeMinor ?? 0, platformFeesMinor: orders._sum.platformFeeMinor ?? 0,
        commissionMinor: commission, pharmacyEarningsMinor: (fulfilments._sum.subtotalMinor ?? 0) - commission,
        sabiRevenueMinor: commission + (orders._sum.deliveryFeeMinor ?? 0) + (orders._sum.platformFeeMinor ?? 0),
      },
      refunds: fold(refunds),
      settlements: fold(settlements),
      unsettled: { fulfilments: unsettled._count._all, netPayableMinor: (unsettled._sum.subtotalMinor ?? 0) - (unsettled._sum.commissionMinor ?? 0) },
      providers: { paystack: paystackConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED', payouts: 'NONE — settlements are paid by bank transfer and recorded with the transfer reference' },
    };
  }));

// ------------------------------------------------------------------------------------------------
// Payments and webhooks
// ------------------------------------------------------------------------------------------------
financeRoutes.get('/payments', allow(...READ),
  validate(z.object({ query: z.object({ status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED']).optional(), q: z.string().trim().max(80).optional(), ...rangeQuery, ...pageQuery }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const { status, q, page, limit } = req.query;
    const where = { ...rangeWhere(req.query), ...(status ? { status } : {}), ...(q ? { OR: [{ providerReference: { contains: q } }, { order: { reference: { contains: q, mode: 'insensitive' } } }] } : {}) };
    const [rows, total] = await Promise.all([
      prisma.paymentAttempt.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        select: { id: true, provider: true, providerReference: true, status: true, amountMinor: true, currency: true, createdAt: true, completedAt: true, expiresAt: true,
          order: { select: { id: true, reference: true, status: true, totalPayableMinor: true } }, _count: { select: { events: true } } } }),
      prisma.paymentAttempt.count({ where }),
    ]);
    return paged(rows.map((r) => ({ ...r, providerEvents: r._count.events, _count: undefined })), total, { page, limit });
  }));

financeRoutes.get('/webhooks', allow(...READ, 'platform.jobs.manage'),
  validate(z.object({ query: z.object({ outcome: z.enum(['APPLIED', 'DUPLICATE', 'IGNORED', 'REJECTED_SIGNATURE', 'REJECTED_INVALID', 'ERROR']).optional(), ...pageQuery }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const { outcome, page, limit } = req.query;
    const where = outcome ? { outcome } : {};
    const day = new Date(Date.now() - 86_400_000);
    const [rows, total, last24h] = await Promise.all([
      prisma.paymentWebhookReceipt.findMany({ where, orderBy: { receivedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.paymentWebhookReceipt.count({ where }),
      prisma.paymentWebhookReceipt.groupBy({ by: ['outcome'], where: { receivedAt: { gte: day } }, _count: { _all: true } }),
    ]);
    return { ...paged(rows, total, { page, limit }), last24h: Object.fromEntries(last24h.map((r) => [r.outcome, r._count._all])) };
  }));

// ------------------------------------------------------------------------------------------------
// Reconciliation: each check names what should be true and lists the records where it is not.
// ------------------------------------------------------------------------------------------------
financeRoutes.get('/reconciliation', allow(...READ),
  validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const now = new Date();
    const [paidWithoutSuccess, successNotPaid, amountMismatch, doubleSuccess, stuckPending, submittedNoReference, failedNoRefund] = await Promise.all([
      prisma.$queryRaw`SELECT o."id", o."reference", o."total_payable_minor" AS "amountMinor", o."updated_at" AS "at" FROM "orders" o
        WHERE o."status" = 'PAID' AND NOT EXISTS (SELECT 1 FROM "payment_attempts" a WHERE a."order_id" = o."id" AND a."status" = 'SUCCESS') ORDER BY o."updated_at" DESC LIMIT 100`,
      prisma.$queryRaw`SELECT o."id", o."reference", a."amount_minor" AS "amountMinor", a."completed_at" AS "at", o."status" AS "orderStatus" FROM "payment_attempts" a JOIN "orders" o ON o."id" = a."order_id"
        WHERE a."status" = 'SUCCESS' AND o."status" <> 'PAID' ORDER BY a."completed_at" DESC LIMIT 100`,
      prisma.$queryRaw`SELECT o."id", o."reference", a."amount_minor" AS "amountMinor", o."total_payable_minor" AS "expectedMinor", a."completed_at" AS "at" FROM "payment_attempts" a JOIN "orders" o ON o."id" = a."order_id"
        WHERE a."status" = 'SUCCESS' AND a."amount_minor" <> o."total_payable_minor" ORDER BY a."completed_at" DESC LIMIT 100`,
      prisma.$queryRaw`SELECT o."id", o."reference", COUNT(*)::int AS "successes", SUM(a."amount_minor")::bigint AS "amountMinor", MAX(a."completed_at") AS "at" FROM "payment_attempts" a JOIN "orders" o ON o."id" = a."order_id"
        WHERE a."status" = 'SUCCESS' GROUP BY o."id", o."reference" HAVING COUNT(*) > 1 ORDER BY MAX(a."completed_at") DESC LIMIT 100`,
      prisma.paymentAttempt.findMany({ where: { status: 'PENDING', expiresAt: { lt: new Date(now - 3_600_000) } }, orderBy: { expiresAt: 'desc' }, take: 100, select: { id: true, providerReference: true, amountMinor: true, expiresAt: true, order: { select: { id: true, reference: true } } } }),
      prisma.refundReviewCase.findMany({ where: { status: 'SUBMITTED', providerRefundReference: null, submittedAt: { lt: new Date(now - 15 * 60_000) } }, take: 100, select: { id: true, amountMinor: true, submittedAt: true, providerStatus: true, failureReason: true, fulfilment: { select: { order: { select: { id: true, reference: true } } } } } }),
      prisma.orderFulfilment.findMany({ where: { status: { in: ['REJECTED', 'UNABLE_TO_FULFILL'] }, order: { status: 'PAID' }, refundCase: { is: null } }, take: 100, select: { id: true, status: true, totalMinor: true, createdAt: true, order: { select: { id: true, reference: true } }, pharmacy: { select: { name: true } } } }),
    ]);
    const n = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
    const check = (key, title, expectation, severity, items) => ({ key, title, expectation, severity, count: items.length, status: items.length ? 'MISMATCH' : 'OK', items });
    return {
      generatedAt: now.toISOString(),
      checks: [
        check('paid-without-success', 'Paid orders with no successful payment', 'Every paid order has a successful payment attempt confirmed by the provider.', 'critical', n(paidWithoutSuccess)),
        check('success-not-paid', 'Successful payments on unpaid orders', 'A successful payment marks its order paid.', 'critical', n(successNotPaid)),
        check('amount-mismatch', 'Payment amount differs from order total', 'The amount captured equals the order total.', 'critical', n(amountMismatch)),
        check('double-charge', 'Orders paid more than once', 'An order has at most one successful payment (otherwise refund the extra).', 'critical', n(doubleSuccess)),
        check('stuck-pending', 'Payments pending an hour past expiry', 'Payment attempts end (success, failure or expiry) by their expiry time; a webhook may have been missed.', 'warning', stuckPending.map((a) => ({ id: a.order.id, reference: a.order.reference, providerReference: a.providerReference, amountMinor: a.amountMinor, at: a.expiresAt }))),
        check('refund-outcome-unknown', 'Refunds submitted with no provider reference', 'A submitted refund has the provider’s refund reference within 15 minutes. Check the Paystack dashboard and record the outcome.', 'critical', submittedNoReference.map((c) => ({ id: c.fulfilment.order.id, reference: c.fulfilment.order.reference, refundCaseId: c.id, amountMinor: c.amountMinor, at: c.submittedAt, providerStatus: c.providerStatus, note: c.failureReason }))),
        check('rejected-without-refund', 'Rejected paid fulfilments with no refund case', 'A paid fulfilment the pharmacy could not fill has a refund case.', 'warning', failedNoRefund.map((f) => ({ id: f.order.id, reference: f.order.reference, pharmacy: f.pharmacy.name, status: f.status, amountMinor: f.totalMinor, at: f.createdAt }))),
      ],
    };
  }));

// ------------------------------------------------------------------------------------------------
// Refunds
// ------------------------------------------------------------------------------------------------
const REFUND_STATUSES = ['PENDING_REVIEW', 'RESOLVED', 'PROPOSED', 'APPROVED', 'DECLINED', 'SUBMITTED', 'REFUNDED', 'FAILED'];

financeRoutes.get('/refunds', allow(...READ),
  validate(z.object({ query: z.object({ status: z.enum([...REFUND_STATUSES, 'OPEN']).optional(), ...pageQuery }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const { status, page, limit } = req.query;
    const where = status === 'OPEN' ? { status: { in: finance.OPEN_REFUND_STATUSES } } : status ? { status } : {};
    const [rows, total] = await Promise.all([
      prisma.refundReviewCase.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: { fulfilment: { select: { id: true, status: true, pharmacy: { select: { name: true } }, order: { select: { id: true, reference: true, patient: { select: { patientId: true, full_name: true } } } } } } } }),
      prisma.refundReviewCase.count({ where }),
    ]);
    const names = await namesFor(prisma, rows.flatMap((r) => [r.proposedByUserId, r.decidedByUserId, r.evidenceRecordedByUserId]));
    return paged(rows.map((r) => ({
      ...r, proposedBy: names.get(r.proposedByUserId) ?? null, decidedBy: names.get(r.decidedByUserId) ?? null, evidenceRecordedBy: names.get(r.evidenceRecordedByUserId) ?? null,
      order: r.fulfilment.order, pharmacy: r.fulfilment.pharmacy.name, fulfilmentStatus: r.fulfilment.status, fulfilment: undefined,
    })), total, { page, limit });
  }));

const note = z.object({ body: z.object({ note: reason }).strict(), query: none, params: idParams });
financeRoutes.post('/refunds/:id/propose', allow('platform.finance.manage'), validate(note), handle((req) => finance.proposeRefund(req, req.params.id, req.body.note)));
financeRoutes.post('/refunds/:id/approve', allow('platform.finance.approve'), requireRecentMfa, validate(note), handle((req) => finance.decideRefund(req, req.params.id, true, req.body.note)));
financeRoutes.post('/refunds/:id/decline', allow('platform.finance.approve'), validate(note), handle((req) => finance.decideRefund(req, req.params.id, false, req.body.note)));
financeRoutes.post('/refunds/:id/submit', allow('platform.finance.manage'), requireRecentMfa,
  validate(z.object({ body: none.optional(), query: none, params: idParams })), handle((req) => finance.submitRefund(req, req.params.id)));
financeRoutes.post('/refunds/:id/evidence', allow('platform.finance.approve'), requireRecentMfa,
  validate(z.object({
    body: z.object({ outcome: z.enum(['REFUNDED', 'FAILED']), providerRefundReference: z.string().trim().min(3).max(120).regex(/^[\w.:-]+$/).optional(), note: reason }).strict()
      .refine((b) => b.outcome !== 'REFUNDED' || b.providerRefundReference, { path: ['providerRefundReference'], message: 'Give the provider’s refund reference as evidence' }),
    query: none, params: idParams,
  })),
  handle((req) => finance.recordRefundEvidence(req, req.params.id, req.body)));

// ------------------------------------------------------------------------------------------------
// Settlements
// ------------------------------------------------------------------------------------------------
const periodBody = { pharmacyId: uuid, periodStart: z.iso.datetime({ offset: true }), periodEnd: z.iso.datetime({ offset: true }) };
const checkPeriod = ({ periodStart, periodEnd }) => {
  const start = new Date(periodStart); const end = new Date(periodEnd);
  if (end <= start) throw ccError('INVALID_RANGE', 400, 'The settlement period must end after it starts.');
  if (end > new Date()) throw ccError('INVALID_RANGE', 400, 'A settlement period cannot end in the future.');
  return { start, end };
};

financeRoutes.get('/settlements', allow(...READ),
  validate(z.object({ query: z.object({ status: z.enum(['DRAFT', 'APPROVED', 'PAID', 'CANCELLED']).optional(), pharmacyId: uuid.optional(), ...pageQuery }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const { status, pharmacyId, page, limit } = req.query;
    const where = { ...(status ? { status } : {}), ...(pharmacyId ? { pharmacyId } : {}) };
    const [rows, total] = await Promise.all([
      prisma.pharmacySettlement.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit, include: { pharmacy: { select: { id: true, name: true } } } }),
      prisma.pharmacySettlement.count({ where }),
    ]);
    const names = await namesFor(prisma, rows.flatMap((s) => [s.preparedByUserId, s.approvedByUserId, s.paidByUserId, s.cancelledByUserId]));
    return paged(rows.map((s) => ({ ...s, idempotencyKey: undefined, preparedBy: names.get(s.preparedByUserId), approvedBy: names.get(s.approvedByUserId) ?? null, paidBy: names.get(s.paidByUserId) ?? null, cancelledBy: names.get(s.cancelledByUserId) ?? null })), total, { page, limit });
  }));

financeRoutes.post('/settlements/preview', allow(...READ),
  validate(z.object({ body: z.object(periodBody).strict(), query: none, params: none })),
  handle(async (req) => {
    const { start, end } = checkPeriod(req.body);
    return finance.settlementPreview(req.body.pharmacyId, start, end);
  }));

financeRoutes.post('/settlements', allow('platform.finance.manage'),
  validate(z.object({ body: z.object({ ...periodBody, idempotencyKey: z.string().trim().min(16).max(128) }).strict(), query: none, params: none })),
  handle(async (req, res) => {
    const { start, end } = checkPeriod(req.body);
    const { settlement, idempotent } = await finance.createSettlement(req, { pharmacyId: req.body.pharmacyId, periodStart: start, periodEnd: end, idempotencyKey: req.body.idempotencyKey });
    res.status(idempotent ? 200 : 201);
    return { ...settlement, idempotencyKey: undefined, idempotent };
  }));

financeRoutes.get('/settlements/:id', allow(...READ),
  validate(z.object({ query: none, params: idParams }).passthrough()),
  handle(async (req) => {
    const s = await prisma.pharmacySettlement.findUnique({ where: { id: req.params.id }, include: { pharmacy: { select: { id: true, name: true } },
      items: { select: { id: true, grossMinor: true, commissionMinor: true, active: true, fulfilment: { select: { id: true, status: true, createdAt: true, order: { select: { id: true, reference: true } } } } } } } });
    if (!s) throw ccError('NOT_FOUND', 404, 'Settlement not found.');
    const names = await namesFor(prisma, [s.preparedByUserId, s.approvedByUserId, s.paidByUserId, s.cancelledByUserId]);
    return { ...s, idempotencyKey: undefined, preparedBy: names.get(s.preparedByUserId), approvedBy: names.get(s.approvedByUserId) ?? null, paidBy: names.get(s.paidByUserId) ?? null, cancelledBy: names.get(s.cancelledByUserId) ?? null };
  }));

financeRoutes.post('/settlements/:id/approve', allow('platform.finance.approve'), requireRecentMfa, validate(note), handle((req) => finance.approveSettlement(req, req.params.id, req.body.note)));
financeRoutes.post('/settlements/:id/paid', allow('platform.finance.approve'), requireRecentMfa,
  validate(z.object({ body: z.object({ payoutReference: z.string().trim().min(4).max(120).regex(/^[\w ./:-]+$/), note: reason }).strict(), query: none, params: idParams })),
  handle((req) => finance.markSettlementPaid(req, req.params.id, req.body)));
financeRoutes.post('/settlements/:id/cancel', allow('platform.finance.manage', 'platform.finance.approve'), validate(note), handle((req) => finance.cancelSettlement(req, req.params.id, req.body.note)));

/** What each pharmacy is owed and not yet on a live settlement (the starting point for a settlement). */
financeRoutes.get('/payables', allow(...READ),
  validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const rows = await prisma.$queryRaw`
      SELECT p."id" AS "pharmacyId", p."name", p."compliance_status" AS "complianceStatus",
             COUNT(f."id")::int AS "fulfilments", COALESCE(SUM(f."subtotal_minor"), 0)::bigint AS "grossMinor",
             COALESCE(SUM(f."commission_minor"), 0)::bigint AS "commissionMinor", MIN(f."created_at") AS "oldestAt"
      FROM "pharmacies" p
      JOIN "order_fulfilments" f ON f."pharmacy_id" = p."id"
      JOIN "orders" o ON o."id" = f."order_id" AND o."status" = 'PAID'
      LEFT JOIN "refund_review_cases" r ON r."fulfilment_id" = f."id"
      WHERE f."status" IN ('DELIVERED', 'PICKED_UP') AND f."commission_minor" IS NOT NULL
        AND (r."id" IS NULL OR r."status" IN ('DECLINED', 'RESOLVED'))
        AND NOT EXISTS (SELECT 1 FROM "pharmacy_settlement_items" i WHERE i."fulfilment_id" = f."id" AND i."active")
      GROUP BY p."id", p."name", p."compliance_status"
      ORDER BY MIN(f."created_at")`;
    return {
      generatedAt: new Date().toISOString(),
      definition: 'Per pharmacy: medicines subtotal of paid, handed-over fulfilments not yet on a live settlement, less commission. Refunded fulfilments are excluded.',
      items: rows.map((r) => ({ ...r, grossMinor: Number(r.grossMinor), commissionMinor: Number(r.commissionMinor), netPayableMinor: Number(r.grossMinor) - Number(r.commissionMinor) })),
    };
  }));
