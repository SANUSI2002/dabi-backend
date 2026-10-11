// /api/v1/command-centre/overview — live platform metrics for a period, each with a written
// definition and the Command Centre section that lists the underlying records. Read straight from
// the primary database (no cache), so `generatedAt` is the freshness of every number.
import express from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { withWorker } from '../emr/core/db.js';
import { allow, ccError, handle } from './cc.common.js';

export const overviewRoutes = express.Router();

const DAY = 86_400_000;
export const DEFAULT_TIME_ZONE = 'Africa/Lagos';

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const query = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  tz: z.string().max(64).optional(),
}).strict();

/** The period asked for: default the last 7 days; at most 366 days. */
export function period(q, now = new Date()) {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * DAY);
  if (from >= to) throw ccError('INVALID_RANGE', 400, 'The start of the period must be before its end.');
  if (to - from > 366 * DAY) throw ccError('INVALID_RANGE', 400, 'Choose a period of at most 366 days.');
  const tz = q.tz ?? DEFAULT_TIME_ZONE;
  if (!validTimeZone(tz)) throw ccError('INVALID_TIME_ZONE', 400, `Unknown time zone "${tz}".`);
  return { from, to, tz };
}

const metric = (key, label, value, unit, definition, drill) => ({ key, label, value, unit, definition, ...(drill ? { drill } : {}) });

async function headline({ from, to }) {
  const inRange = { gte: from, lt: to };
  const [
    signedIn, ordersPlaced, paidOrders, paidAgg, attempts, commission, deliveryFees, delivered,
    consultations, consultationsCompleted, prescriptionsIssued,
  ] = await Promise.all([
    prisma.auditEvent.groupBy({ by: ['actorUserId'], where: { action: { in: ['SIGNED_IN', 'SIGNED_IN_MFA'] }, createdAt: inRange } }).then((r) => r.length),
    prisma.order.count({ where: { createdAt: inRange } }),
    prisma.order.count({ where: { createdAt: inRange, status: 'PAID' } }),
    prisma.order.aggregate({ where: { createdAt: inRange, status: 'PAID' }, _sum: { totalPayableMinor: true } }),
    prisma.paymentAttempt.groupBy({ by: ['status'], where: { completedAt: inRange }, _count: { _all: true } }),
    prisma.orderFulfilment.aggregate({ where: { order: { status: 'PAID', createdAt: inRange } }, _sum: { commissionMinor: true } }),
    prisma.orderFulfilment.aggregate({ where: { fulfilmentMethod: 'DELIVERY', order: { status: 'PAID', createdAt: inRange } }, _sum: { deliveryFeeMinor: true }, _count: { _all: true } }),
    prisma.deliveryAssignment.count({ where: { deliveredAt: inRange } }),
    prisma.doctorAppointment.count({ where: { startsAt: inRange } }),
    prisma.doctorAppointment.count({ where: { startsAt: inRange, status: 'COMPLETED' } }),
    prisma.prescription.count({ where: { issuedAt: inRange } }),
  ]);
  const byStatus = Object.fromEntries(attempts.map((a) => [a.status, a._count._all]));
  const settled = (byStatus.SUCCESS ?? 0) + (byStatus.FAILED ?? 0) + (byStatus.EXPIRED ?? 0) + (byStatus.CANCELLED ?? 0);
  const failedPayments = settled - (byStatus.SUCCESS ?? 0);
  const deliveryCount = deliveryFees._count._all;
  return [
    metric('activeUsers', 'People who signed in', signedIn, 'count', 'Distinct accounts with at least one successful sign-in in the period (from the sign-in audit trail).', { section: 'audit', filter: { category: 'SIGN_IN' } }),
    metric('ordersPlaced', 'Orders placed', ordersPlaced, 'count', 'Marketplace orders created in the period, whatever their payment outcome.', { section: 'orders' }),
    metric('ordersPaid', 'Orders paid', paidOrders, 'count', 'Orders created in the period whose payment was confirmed by the payment provider (webhook).', { section: 'orders', filter: { status: 'PAID' } }),
    metric('grossMerchandiseValue', 'Gross order value', paidAgg._sum.totalPayableMinor ?? 0, 'kobo', 'Total payable (medicines, delivery and platform fee) of paid orders created in the period. Refunds are not deducted.', { section: 'finance' }),
    metric('commission', 'Commission earned', commission._sum.commissionMinor ?? 0, 'kobo', 'Sabi commission on fulfilments of paid orders created in the period, at the tier rate frozen on each fulfilment.', { section: 'finance' }),
    metric('deliveryFees', 'Delivery fees charged', deliveryFees._sum.deliveryFeeMinor ?? 0, 'kobo', 'Delivery fees on paid delivery fulfilments created in the period, as quoted at checkout.', { section: 'pricing' }),
    metric('averageDeliveryFee', 'Average delivery fee', deliveryCount ? Math.round((deliveryFees._sum.deliveryFeeMinor ?? 0) / deliveryCount) : null, 'kobo', 'Delivery fees charged divided by the number of paid delivery fulfilments; empty when there were none.', { section: 'pricing' }),
    metric('paymentFailureRate', 'Payment failure rate', settled ? Math.round((failedPayments / settled) * 1000) / 10 : null, 'percent', 'Payment attempts that ended failed, expired or cancelled, as a share of all attempts that ended in the period; empty when none ended.', { section: 'finance', filter: { tab: 'payments', status: 'FAILED' } }),
    metric('deliveriesCompleted', 'Deliveries completed', delivered, 'count', 'Deliveries handed over to the patient (delivery code confirmed) in the period.', { section: 'deliveries' }),
    metric('consultations', 'Consultations scheduled', consultations, 'count', 'Doctor appointments whose start time falls in the period, any status.', { section: 'consultations' }),
    metric('consultationsCompleted', 'Consultations completed', consultationsCompleted, 'count', 'Doctor appointments in the period that the doctor marked completed.', { section: 'consultations', filter: { status: 'COMPLETED' } }),
    metric('prescriptionsIssued', 'Prescriptions issued', prescriptionsIssued, 'count', 'Prescriptions a doctor issued (signed) in the period.', { section: 'consultations' }),
  ];
}

/** Work waiting on someone right now (not tied to the period). */
async function queues(now = new Date()) {
  const in30 = new Date(now.getTime() + 30 * DAY);
  const reviewSla = new Date(now.getTime() - 2 * 3_600_000);
  const day = new Date(now.getTime() - DAY);
  const [
    doctorApps, pharmacyApps, listings, refunds, cases, incidents, slaBreaches, failedNotifications, deadWebhooks, failedEmails,
    licencesExpiring, branchLicencesExpiring, emergencyToReview, unassignedDeliveries,
  ] = await Promise.all([
    prisma.professionalProfile.count({ where: { verificationStatus: 'PENDING', doctorApplication: { stage: { in: ['SUBMITTED', 'PENDING_REVIEW'] } } } }),
    prisma.pharmacy.count({ where: { complianceStatus: 'PENDING', applicationSubmittedAt: { not: null } } }),
    prisma.pharmacyListing.count({ where: { status: 'SUBMITTED' } }),
    prisma.refundReviewCase.count({ where: { status: { in: ['PENDING_REVIEW', 'PROPOSED', 'APPROVED', 'SUBMITTED', 'FAILED'] } } }),
    prisma.opsCase.count({ where: { kind: 'SUPPORT', status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING'] } } }),
    prisma.opsCase.count({ where: { kind: 'INCIDENT', status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING'] } } }),
    prisma.orderFulfilment.count({ where: { status: 'AWAITING_PHARMACIST_REVIEW', order: { updatedAt: { lt: reviewSla } } } }),
    prisma.notificationDelivery.count({ where: { status: 'FAILED', updatedAt: { gte: day } } }),
    // EMR rows are tenant-scoped (row-level security); the worker context may count deliveries only.
    withWorker((tx) => tx.emrWebhookDelivery.count({ where: { status: 'DEAD' } })),
    prisma.pharmacyEmailJob.count({ where: { status: 'FAILED' } }),
    prisma.pharmacy.count({ where: { complianceStatus: 'VERIFIED', superintendentLicenceExpiresAt: { lt: in30 } } }),
    prisma.pharmacyBranch.count({ where: { status: 'VERIFIED', licenceExpiresAt: { lt: in30 } } }),
    prisma.emergencyAccessGrant.count({ where: { reviewedAt: null } }),
    prisma.orderFulfilment.count({ where: { fulfilmentMethod: 'DELIVERY', status: 'READY_FOR_PICKUP', deliveryAssignments: { none: { status: { in: ['PENDING', 'ACCEPTED'] } } } } }),
  ]);
  const q = (key, label, value, definition, drill, severity = 'info') => ({ key, label, value, definition, drill, severity: value > 0 ? severity : 'ok' });
  return [
    q('doctorApplications', 'Doctor applications to review', doctorApps, 'Submitted doctor applications awaiting a verification decision.', { section: 'doctors' }, 'attention'),
    q('pharmacyApplications', 'Pharmacy applications to review', pharmacyApps, 'Submitted pharmacy applications awaiting a compliance decision.', { section: 'pharmacies' }, 'attention'),
    q('listingsToReview', 'Products to review', listings, 'Marketplace listings submitted by pharmacies and awaiting review.', { section: 'pharmacies', filter: { tab: 'listings' } }, 'attention'),
    q('pharmacistReviewOverdue', 'Orders waiting on a pharmacist > 2 h', slaBreaches, 'Paid fulfilments still awaiting pharmacist review two hours after the order last changed.', { section: 'orders', filter: { fulfilmentStatus: 'AWAITING_PHARMACIST_REVIEW' } }, 'warning'),
    q('unassignedDeliveries', 'Ready deliveries with no rider', unassignedDeliveries, 'Delivery fulfilments ready for pickup with no pending or accepted rider assignment.', { section: 'deliveries', filter: { unassigned: true } }, 'warning'),
    q('refundsOpen', 'Refunds in progress', refunds, 'Refund cases not yet refunded or declined (including failed provider refunds).', { section: 'finance', filter: { tab: 'refunds' } }, 'attention'),
    q('supportOpen', 'Open support cases', cases, 'Support cases that are open, in progress or waiting.', { section: 'support' }, 'info'),
    q('incidentsOpen', 'Open incidents', incidents, 'Incidents that are not resolved or closed.', { section: 'incidents' }, 'critical'),
    q('failedNotifications', 'Notifications failed (24 h)', failedNotifications, 'Patient notifications (WhatsApp, push, email) that permanently failed in the last 24 hours.', { section: 'jobs', filter: { type: 'notification', status: 'FAILED' } }, 'warning'),
    q('deadWebhooks', 'Hospital webhooks given up', deadWebhooks, 'EMR webhook deliveries that exhausted their retries.', { section: 'jobs', filter: { type: 'emr-webhook', status: 'DEAD' } }, 'warning'),
    q('failedEmails', 'Pharmacy emails failed', failedEmails, 'Pharmacy notification emails that failed permanently (retries exhausted or not sendable).', { section: 'jobs', filter: { type: 'pharmacy-email' } }, 'warning'),
    q('licencesExpiring', 'Licences expiring in 30 days', licencesExpiring + branchLicencesExpiring, 'Verified pharmacies whose superintendent licence, or verified branches whose premises licence, expires within 30 days (or has expired).', { section: 'providers', filter: { tab: 'expiring' } }, 'warning'),
    q('emergencyAccessToReview', 'Emergency access to review', emergencyToReview, 'Emergency (break-glass) access grants not yet reviewed by compliance.', { section: 'audit', filter: { tab: 'emergency' } }, 'attention'),
  ];
}

/** Paid orders and their value per local day in `tz`. */
async function daily({ from, to, tz }) {
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT to_char(date_trunc('day', ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS "day",
           COUNT(*)::int AS "orders",
           COUNT(*) FILTER (WHERE "status" = 'PAID')::int AS "paid",
           COALESCE(SUM("total_payable_minor") FILTER (WHERE "status" = 'PAID'), 0)::bigint AS "paidValueMinor"
    FROM "orders" WHERE "created_at" >= ${from} AND "created_at" < ${to}
    GROUP BY 1 ORDER BY 1`);
  return rows.map((r) => ({ day: r.day, orders: r.orders, paid: r.paid, paidValueMinor: Number(r.paidValueMinor) }));
}

overviewRoutes.get('/', allow('platform.ops.read', 'platform.finance.read'),
  validate(z.object({ query, params: z.object({}).strict() }).passthrough()),
  handle(async (req) => {
    const range = period(req.query);
    const [metrics, waiting, series] = await Promise.all([headline(range), queues(), daily(range)]);
    return {
      period: { from: range.from.toISOString(), to: range.to.toISOString(), timeZone: range.tz },
      generatedAt: new Date().toISOString(),
      freshness: 'Live: read from the primary database when this response was generated.',
      metrics,
      queues: waiting,
      daily: series,
    };
  }));
