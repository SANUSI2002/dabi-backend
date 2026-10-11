// Finance operations for the Command Centre: refunds and pharmacy settlements.
//
// Refund case lifecycle (refund_review_cases.status):
//   PENDING_REVIEW ──propose (finance.manage)──► PROPOSED ──approve (finance.approve, a different
//   person)──► APPROVED ──submit (finance.manage)──► SUBMITTED ──provider webhook──► REFUNDED
//                                                              └───────────────────► FAILED ─► (submit again)
//   PENDING_REVIEW / PROPOSED ──decline (finance.approve)──► DECLINED
// A case is REFUNDED only on evidence from the provider: its refund webhook, or a provider refund
// reference recorded by someone other than the proposer. Nothing marks money as moved on our word.
//
// Settlement lifecycle (pharmacy_settlements.status): DRAFT ─approve (another person)─► APPROVED
// ─record bank transfer reference─► PAID; DRAFT/APPROVED ─cancel─► CANCELLED (items released).
import { randomBytes } from 'node:crypto';
import prisma from '../../config/db.js';
import * as paystack from '../payments/paystack.adapter.js';
import { adminAudit, ccError } from './cc.common.js';

export const OPEN_REFUND_STATUSES = ['PENDING_REVIEW', 'PROPOSED', 'APPROVED', 'SUBMITTED', 'FAILED'];
const reference = (prefix) => `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex').toUpperCase()}`;

async function lockedCase(tx, id) {
  await tx.$queryRaw`SELECT "id" FROM "refund_review_cases" WHERE "id" = ${id} FOR UPDATE`;
  const c = await tx.refundReviewCase.findUnique({ where: { id }, include: { fulfilment: { select: { id: true, orderId: true, order: { select: { id: true, reference: true, patientId: true, status: true } } } } } });
  if (!c) throw ccError('NOT_FOUND', 404, 'Refund case not found.');
  return c;
}
const need = (c, statuses, verb) => {
  if (!statuses.includes(c.status)) throw ccError('INVALID_STATE', 409, `This refund is ${c.status.replaceAll('_', ' ').toLowerCase()} and cannot be ${verb}.`, { status: c.status });
};
const refundAudit = (tx, req, c, summary, why, before, after) => adminAudit(tx, req, {
  summary: `${summary} (${c.fulfilment.order.reference})`, resourceType: 'order', resourceId: c.fulfilment.order.id, reason: why,
  before: { refundStatus: before }, after: { refundStatus: after, refundCaseId: c.id, amountMinor: c.amountMinor },
});

export const proposeRefund = (req, id, note) => prisma.$transaction(async (tx) => {
  const c = await lockedCase(tx, id);
  need(c, ['PENDING_REVIEW'], 'proposed');
  const updated = await tx.refundReviewCase.update({ where: { id }, data: { status: 'PROPOSED', proposedByUserId: req.user.id, proposedAt: new Date(), proposalNote: note, version: { increment: 1 } } });
  await refundAudit(tx, req, c, `Proposed a refund of ${c.amountMinor} kobo`, note, c.status, 'PROPOSED');
  return updated;
});

export const decideRefund = (req, id, approve, note) => prisma.$transaction(async (tx) => {
  const c = await lockedCase(tx, id);
  need(c, approve ? ['PROPOSED'] : ['PENDING_REVIEW', 'PROPOSED'], approve ? 'approved' : 'declined');
  if (approve && c.proposedByUserId === req.user.id) throw ccError('SAME_PERSON', 403, 'A refund must be approved by someone other than the person who proposed it.');
  const status = approve ? 'APPROVED' : 'DECLINED';
  const updated = await tx.refundReviewCase.update({ where: { id }, data: { status, decidedByUserId: req.user.id, decidedAt: new Date(), decisionNote: note, version: { increment: 1 } } });
  await refundAudit(tx, req, c, approve ? 'Approved a refund' : 'Declined a refund', note, c.status, status);
  return updated;
});

/**
 * Sends an approved (or previously failed) refund to the payment provider. The case is moved to
 * SUBMITTED inside a locked transaction before the provider is called, so two clicks cannot send two
 * refunds. If the provider call fails cleanly the case becomes FAILED (and may be submitted again);
 * if the outcome is unknown (timeout) it stays SUBMITTED without a reference and reconciliation
 * flags it for a person to check the provider dashboard — it is never re-sent automatically.
 */
export async function submitRefund(req, id) {
  if (!paystack.configured()) throw ccError('PROVIDER_NOT_CONFIGURED', 503, 'Refunds cannot be sent: the Paystack secret key is not configured on this server. The case stays approved.');
  const prepared = await prisma.$transaction(async (tx) => {
    const c = await lockedCase(tx, id);
    need(c, ['APPROVED', 'FAILED'], 'submitted');
    const success = await tx.paymentAttempt.findFirst({ where: { orderId: c.fulfilment.orderId, status: 'SUCCESS' }, orderBy: { completedAt: 'desc' }, select: { provider: true, providerReference: true, amountMinor: true } });
    if (!success) throw ccError('INVALID_STATE', 409, 'No successful payment was found for this order, so there is nothing to refund.');
    const alreadyRefunded = await tx.refundReviewCase.aggregate({ where: { orderId: c.orderId, status: { in: ['SUBMITTED', 'REFUNDED'] }, id: { not: c.id } }, _sum: { amountMinor: true } });
    if ((alreadyRefunded._sum.amountMinor ?? 0) + c.amountMinor > success.amountMinor) throw ccError('INVALID_STATE', 409, 'This refund would exceed what the patient paid for the order.');
    await tx.refundReviewCase.update({ where: { id }, data: { status: 'SUBMITTED', submittedAt: new Date(), provider: success.provider, providerRefundReference: null, providerStatus: null, failureReason: null, version: { increment: 1 } } });
    await refundAudit(tx, req, c, 'Submitted a refund to the payment provider', null, c.status, 'SUBMITTED');
    return { c, transactionReference: success.providerReference };
  });
  try {
    const result = await paystack.refund({ transactionReference: prepared.transactionReference, amountMinor: prepared.c.amountMinor });
    return prisma.refundReviewCase.update({ where: { id }, data: { providerRefundReference: result.reference, providerStatus: result.status } });
  } catch (error) {
    if (error.unknownOutcome) {
      await prisma.refundReviewCase.update({ where: { id }, data: { providerStatus: 'UNKNOWN', failureReason: error.providerMessage } });
      throw ccError('PROVIDER_OUTCOME_UNKNOWN', 502, 'Paystack did not answer in time. The refund may or may not have been created: check the Paystack dashboard and record the refund reference, or mark it failed.');
    }
    await prisma.refundReviewCase.update({ where: { id }, data: { status: 'FAILED', providerStatus: 'REJECTED', failureReason: error.providerMessage ?? 'Provider error' } });
    throw ccError('PROVIDER_REJECTED', 502, `Paystack refused the refund: ${error.providerMessage ?? 'no reason given'}.`);
  }
}

/** Records provider evidence for a submitted refund (when its webhook did not arrive). */
export const recordRefundEvidence = (req, id, { outcome, providerRefundReference, note }) => prisma.$transaction(async (tx) => {
  const c = await lockedCase(tx, id);
  need(c, ['SUBMITTED'], 'confirmed');
  if (c.proposedByUserId === req.user.id) throw ccError('SAME_PERSON', 403, 'Evidence must be recorded by someone other than the person who proposed the refund.');
  if (c.providerRefundReference && providerRefundReference !== c.providerRefundReference) throw ccError('INVALID_STATE', 409, 'That reference does not match the refund Paystack returned for this case.');
  const refunded = outcome === 'REFUNDED';
  const updated = await tx.refundReviewCase.update({
    where: { id },
    data: refunded
      ? { status: 'REFUNDED', providerRefundReference, providerStatus: 'processed (recorded)', evidenceNote: note, evidenceRecordedByUserId: req.user.id, refundedAt: new Date(), version: { increment: 1 } }
      : { status: 'FAILED', providerRefundReference: providerRefundReference ?? c.providerRefundReference, providerStatus: 'failed (recorded)', failureReason: note, evidenceNote: note, evidenceRecordedByUserId: req.user.id, version: { increment: 1 } },
  });
  await refundAudit(tx, req, c, refunded ? `Recorded provider evidence that the refund was paid (${providerRefundReference})` : 'Recorded that the provider refund failed', note, c.status, updated.status);
  return updated;
});

/**
 * Paystack refund webhooks (signature already verified). Matches the case by Paystack's refund id,
 * or by transaction reference and amount for a case submitted without one. Returns what happened.
 */
export async function applyRefundWebhook(event) {
  const data = event?.data ?? {};
  const outcome = { 'refund.processed': 'REFUNDED', 'refund.failed': 'FAILED' }[event.event];
  const refundId = data.id !== undefined ? String(data.id) : data.refund_reference ? String(data.refund_reference) : null;
  const transactionReference = data.transaction_reference ?? data.transaction?.reference ?? null;
  return prisma.$transaction(async (tx) => {
    let c = refundId ? await tx.refundReviewCase.findUnique({ where: { providerRefundReference: refundId } }) : null;
    if (!c && transactionReference) {
      const attempt = await tx.paymentAttempt.findUnique({ where: { providerReference: String(transactionReference) }, select: { orderId: true } });
      if (attempt) c = await tx.refundReviewCase.findFirst({ where: { orderId: attempt.orderId, status: 'SUBMITTED', providerRefundReference: null, amountMinor: Number(data.amount) } });
    }
    if (!c) return { ignored: true, reference: transactionReference, detail: 'No matching refund case' };
    if (!outcome) {
      await tx.refundReviewCase.update({ where: { id: c.id }, data: { providerStatus: String(data.status ?? event.event).slice(0, 32) } });
      return { applied: true, reference: transactionReference, detail: event.event };
    }
    if (c.status !== 'SUBMITTED') return { duplicate: true, reference: transactionReference, detail: `Case already ${c.status}` };
    if (data.amount !== undefined && Number(data.amount) !== c.amountMinor) return { ignored: true, reference: transactionReference, detail: 'Amount does not match the case' };
    await tx.refundReviewCase.update({
      where: { id: c.id },
      data: outcome === 'REFUNDED'
        ? { status: 'REFUNDED', refundedAt: new Date(), providerStatus: 'processed', providerRefundReference: c.providerRefundReference ?? refundId, version: { increment: 1 } }
        : { status: 'FAILED', providerStatus: 'failed', failureReason: String(data.reason ?? data.message ?? 'Refund failed at Paystack').slice(0, 300), version: { increment: 1 } },
    });
    return { applied: true, reference: transactionReference, detail: outcome === 'REFUNDED' ? 'Refund processed by Paystack' : 'Refund failed at Paystack' };
  });
}

// ------------------------------------------------------------------------------------------------
// Settlements
// ------------------------------------------------------------------------------------------------
/** Fulfilments a pharmacy is owed for: paid, handed over, commission recorded, not refunded, not already on a live settlement. */
export function settleableWhere(pharmacyId, periodStart, periodEnd) {
  return {
    pharmacyId,
    status: { in: ['DELIVERED', 'PICKED_UP'] },
    order: { status: 'PAID' },
    createdAt: { gte: periodStart, lt: periodEnd },
    commissionMinor: { not: null },
    settlementItems: { none: { active: true } },
    OR: [{ refundCase: { is: null } }, { refundCase: { is: { status: { in: ['DECLINED', 'RESOLVED'] } } } }],
  };
}

export async function settlementPreview(pharmacyId, periodStart, periodEnd, db = prisma) {
  const [rows, missingCommission] = await Promise.all([
    db.orderFulfilment.findMany({ where: settleableWhere(pharmacyId, periodStart, periodEnd), orderBy: { createdAt: 'asc' }, select: { id: true, subtotalMinor: true, commissionMinor: true, createdAt: true, status: true, order: { select: { reference: true } } } }),
    db.orderFulfilment.count({ where: { ...settleableWhere(pharmacyId, periodStart, periodEnd), commissionMinor: null } }),
  ]);
  const gross = rows.reduce((n, r) => n + r.subtotalMinor, 0);
  const commission = rows.reduce((n, r) => n + r.commissionMinor, 0);
  return {
    definition: 'Medicines subtotal of paid fulfilments the patient received (picked up or delivered) in the period, less Sabi commission at the rate frozen on each fulfilment. Delivery and platform fees are Sabi revenue and are not owed to the pharmacy. Refunded fulfilments are excluded.',
    fulfilments: rows.map((r) => ({ id: r.id, orderReference: r.order.reference, status: r.status, createdAt: r.createdAt, grossMinor: r.subtotalMinor, commissionMinor: r.commissionMinor, netMinor: r.subtotalMinor - r.commissionMinor })),
    fulfilmentCount: rows.length, grossMinor: gross, commissionMinor: commission, netPayableMinor: gross - commission,
    excludedMissingCommission: missingCommission,
  };
}

export async function createSettlement(req, { pharmacyId, periodStart, periodEnd, idempotencyKey }) {
  const existing = await prisma.pharmacySettlement.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.pharmacyId !== pharmacyId || existing.periodStart.getTime() !== periodStart.getTime() || existing.periodEnd.getTime() !== periodEnd.getTime()) {
      throw ccError('IDEMPOTENCY_CONFLICT', 409, 'This idempotency key was already used for a different settlement.');
    }
    return { settlement: existing, idempotent: true };
  }
  try {
    const settlement = await prisma.$transaction(async (tx) => {
      const pharmacy = await tx.pharmacy.findUnique({ where: { id: pharmacyId }, select: { id: true, name: true } });
      if (!pharmacy) throw ccError('NOT_FOUND', 404, 'Pharmacy not found.');
      const preview = await settlementPreview(pharmacyId, periodStart, periodEnd, tx);
      if (!preview.fulfilmentCount) throw ccError('NOTHING_TO_SETTLE', 409, 'There is nothing to settle for this pharmacy in that period.');
      const created = await tx.pharmacySettlement.create({
        data: {
          reference: reference('STL'), pharmacyId, periodStart, periodEnd, fulfilmentCount: preview.fulfilmentCount, grossMinor: preview.grossMinor,
          commissionMinor: preview.commissionMinor, netPayableMinor: preview.netPayableMinor, idempotencyKey, preparedByUserId: req.user.id,
          items: { create: preview.fulfilments.map((f) => ({ fulfilmentId: f.id, grossMinor: f.grossMinor, commissionMinor: f.commissionMinor })) },
        },
      });
      await adminAudit(tx, req, { summary: `Prepared settlement ${created.reference} for ${pharmacy.name}: ${created.netPayableMinor} kobo`, resourceType: 'settlement', resourceId: created.id, after: { status: 'DRAFT', netPayableMinor: created.netPayableMinor, fulfilmentCount: created.fulfilmentCount } });
      return created;
    });
    return { settlement, idempotent: false };
  } catch (error) {
    if (error.code === 'P2002') throw ccError('ALREADY_SETTLED', 409, 'Some of these fulfilments were put on another settlement at the same time. Refresh and try again.');
    throw error;
  }
}

async function lockedSettlement(tx, id) {
  await tx.$queryRaw`SELECT "id" FROM "pharmacy_settlements" WHERE "id" = ${id} FOR UPDATE`;
  const s = await tx.pharmacySettlement.findUnique({ where: { id }, include: { pharmacy: { select: { name: true } } } });
  if (!s) throw ccError('NOT_FOUND', 404, 'Settlement not found.');
  return s;
}

export const approveSettlement = (req, id, note) => prisma.$transaction(async (tx) => {
  const s = await lockedSettlement(tx, id);
  if (s.status !== 'DRAFT') throw ccError('INVALID_STATE', 409, `This settlement is ${s.status.toLowerCase()}.`);
  if (s.preparedByUserId === req.user.id) throw ccError('SAME_PERSON', 403, 'A settlement must be approved by someone other than the person who prepared it.');
  const updated = await tx.pharmacySettlement.update({ where: { id }, data: { status: 'APPROVED', approvedByUserId: req.user.id, approvedAt: new Date(), version: { increment: 1 } } });
  await adminAudit(tx, req, { summary: `Approved settlement ${s.reference} for ${s.pharmacy.name}`, resourceType: 'settlement', resourceId: s.id, reason: note, before: { status: 'DRAFT' }, after: { status: 'APPROVED', netPayableMinor: s.netPayableMinor } });
  return updated;
});

/** Sabi has no payout provider connected: payment is made by bank transfer and recorded here with its reference. */
export const markSettlementPaid = (req, id, { payoutReference, note }) => prisma.$transaction(async (tx) => {
  const s = await lockedSettlement(tx, id);
  if (s.status !== 'APPROVED') throw ccError('INVALID_STATE', 409, s.status === 'DRAFT' ? 'Approve the settlement before recording payment.' : `This settlement is ${s.status.toLowerCase()}.`);
  const updated = await tx.pharmacySettlement.update({ where: { id }, data: { status: 'PAID', paidByUserId: req.user.id, paidAt: new Date(), payoutReference, payoutNote: note, version: { increment: 1 } } });
  await adminAudit(tx, req, { summary: `Recorded bank transfer ${payoutReference} for settlement ${s.reference}`, resourceType: 'settlement', resourceId: s.id, reason: note, before: { status: 'APPROVED' }, after: { status: 'PAID', payoutReference } });
  return updated;
});

export const cancelSettlement = (req, id, why) => prisma.$transaction(async (tx) => {
  const s = await lockedSettlement(tx, id);
  if (!['DRAFT', 'APPROVED'].includes(s.status)) throw ccError('INVALID_STATE', 409, `A ${s.status.toLowerCase()} settlement cannot be cancelled.`);
  await tx.pharmacySettlementItem.updateMany({ where: { settlementId: id }, data: { active: false } });
  const updated = await tx.pharmacySettlement.update({ where: { id }, data: { status: 'CANCELLED', cancelledByUserId: req.user.id, cancelledAt: new Date(), cancelReason: why, version: { increment: 1 } } });
  await adminAudit(tx, req, { summary: `Cancelled settlement ${s.reference}`, resourceType: 'settlement', resourceId: s.id, reason: why, before: { status: s.status }, after: { status: 'CANCELLED' } });
  return updated;
});
