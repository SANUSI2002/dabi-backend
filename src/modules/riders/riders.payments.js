import { randomUUID } from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';
import prisma from '../../config/db.js';
import * as provider from '../payments/paystack.operations.js';
import { ownRider } from './riders.operations.js';
import { audit } from '../delivery/delivery.repository.js';
import { adminAudit, ccError } from '../command-centre/cc.common.js';

const payoutSelect = { id: true, reference: true, amountMinor: true, currency: true, status: true, accountLast4: true, bankRevision: true, createdAt: true, approvedAt: true, submittedAt: true, paidAt: true, providerErrorCode: true };
const bankSelect = { bankCode: true, bankName: true, accountName: true, accountLast4: true, revision: true, verifiedAt: true };
export const normalizedName = (name) => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter((p) => p && !['MR', 'MRS', 'MISS', 'DR', 'MS'].includes(p)).sort().join(' ');
export async function riderEarnings(userId, { page = 1, limit = 25 } = {}, db = prisma) {
  const p = await ownRider(db, userId);
  const [earned, available, paid, held, items, total, payouts, bank] = await Promise.all([
    db.riderEarning.aggregate({ where: { partnerId: p.id }, _sum: { amountMinor: true } }),
    db.riderEarning.aggregate({ where: { partnerId: p.id, payoutLine: { is: null } }, _sum: { amountMinor: true } }),
    db.riderPayout.aggregate({ where: { partnerId: p.id, status: 'PAID' }, _sum: { amountMinor: true } }),
    db.riderPayout.aggregate({ where: { partnerId: p.id, status: { not: 'PAID' } }, _sum: { amountMinor: true } }),
    db.riderEarning.findMany({ where: { partnerId: p.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit, select: { id: true, amountMinor: true, policyVersion: true, createdAt: true, payoutLine: { select: { payout: { select: { id: true, status: true } } } }, assignment: { select: { fulfilment: { select: { order: { select: { reference: true } }, pharmacy: { select: { name: true } } } } } } } }),
    db.riderEarning.count({ where: { partnerId: p.id } }),
    db.riderPayout.findMany({ where: { partnerId: p.id }, orderBy: { createdAt: 'desc' }, take: 25, select: payoutSelect }),
    db.riderBankAccount.findUnique({ where: { partnerId: p.id }, select: bankSelect }),
  ]);
  return { currency: 'NGN', earnedMinor: earned._sum.amountMinor || 0, availableMinor: available._sum.amountMinor || 0, paidMinor: paid._sum.amountMinor || 0, heldMinor: held._sum.amountMinor || 0, items: items.map((e) => ({ id: e.id, amountMinor: e.amountMinor, createdAt: e.createdAt, orderReference: e.assignment.fulfilment.order.reference, pharmacy: e.assignment.fulfilment.pharmacy.name, payoutStatus: e.payoutLine?.payout.status || 'AVAILABLE' })), total, page, limit, payouts, bank, providerConfigured: provider.operationsConfigured(), note: 'Your offered earning is frozen when the delivery is assigned. It is credited only after the patient delivery code confirms successful delivery. Historical deliveries without an earning offer need operations review.' };
}
export async function saveRiderBank(userId, data, { db = prisma, gateway = provider } = {}) {
  const profile = await ownRider(db, userId);
  const identity = await db.user.findUnique({ where: { id: userId }, select: { full_name: true, riderApplication: { select: { fullName: true, status: true } } } });
  const bank = (await gateway.bankList()).find((b) => b.code === data.bankCode && b.active !== false);
  if (!bank) throw ccError('BANK_NOT_SUPPORTED', 400, 'Choose a supported Nigerian bank.');
  const resolved = await gateway.resolveBank(data.accountNumber, data.bankCode);
  const legalName = identity.riderApplication?.status === 'APPROVED' ? identity.riderApplication.fullName : identity.full_name;
  if (!legalName || !normalizedName(resolved.account_name) || normalizedName(legalName) !== normalizedName(resolved.account_name) || resolved.account_number !== data.accountNumber) throw ccError('BANK_NAME_MISMATCH', 422, 'The bank account name must match your approved rider identity. Contact Sabi operations if your legal name needs correcting.');
  const recipient = await gateway.createRecipient({ name: resolved.account_name, accountNumber: data.accountNumber, bankCode: data.bankCode });
  if (!/^RCP_[A-Za-z0-9]+$/.test(recipient.recipient_code || '')) throw ccError('PROVIDER_INVALID_RESPONSE', 503, 'The bank account could not be verified. Please retry.');
  return db.$transaction(async (tx) => {
    await ownRider(tx, userId);
    await tx.$queryRaw`SELECT id FROM delivery_partners WHERE id = ${profile.id} FOR UPDATE`;
    const prior = await tx.riderBankAccount.findUnique({ where: { partnerId: profile.id } });
    if ((prior?.revision || 0) !== data.expectedRevision) throw ccError('VERSION_CONFLICT', 409, 'Your bank details changed. Refresh before saving.');
    const fields = { recipientCode: recipient.recipient_code, bankCode: data.bankCode, bankName: String(bank.name).slice(0, 120), accountName: String(resolved.account_name).slice(0, 160), accountLast4: data.accountNumber.slice(-4), verifiedAt: new Date() };
    const result = await tx.riderBankAccount.upsert({ where: { partnerId: profile.id }, create: { partnerId: profile.id, ...fields }, update: { ...fields, revision: { increment: 1 } }, select: bankSelect });
    await audit(tx, userId, 'RIDER_PAYOUT_BANK_UPDATED', profile.id);
    return result;
  });
}
export async function requestRiderPayout(userId, data, db = prisma) {
  return db.$transaction(async (tx) => {
    const profile = await ownRider(tx, userId);
    await tx.$queryRaw`SELECT id FROM delivery_partners WHERE id = ${profile.id} FOR UPDATE`;
    const prior = await tx.riderPayout.findUnique({ where: { partnerId_requestKey: { partnerId: profile.id, requestKey: data.requestKey } }, select: payoutSelect });
    if (prior) {
      if (prior.bankRevision !== data.expectedBankRevision) throw ccError('IDEMPOTENCY_CONFLICT', 409, 'This request reference belongs to a different bank revision.');
      return prior;
    }
    const bank = await tx.riderBankAccount.findUnique({ where: { partnerId: profile.id } });
    if (!bank) throw ccError('BANK_REQUIRED', 409, 'Add and verify your own bank account before requesting a payout.');
    if (bank.revision !== data.expectedBankRevision) throw ccError('VERSION_CONFLICT', 409, 'Your bank details changed. Refresh before requesting a payout.');
    const due = await tx.riderEarning.findMany({ where: { partnerId: profile.id, payoutLine: { is: null } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 });
    const selected = []; let amount = 0;
    for (const e of due) { if (amount + e.amountMinor > 1000000000) break; selected.push(e); amount += e.amountMinor; }
    if (!selected.length) throw ccError('NO_AVAILABLE_EARNINGS', 409, 'There are no unallocated earnings to withdraw.');
    const payout = await tx.riderPayout.create({ data: { id: randomUUID(), partnerId: profile.id, requestKey: data.requestKey, reference: `sabi-rider-${randomUUID()}`, amountMinor: amount, bankRevision: bank.revision, recipientCode: bank.recipientCode, accountLast4: bank.accountLast4, requestedByUserId: userId }, select: payoutSelect });
    await tx.riderPayoutLine.createMany({ data: selected.map((e) => ({ id: randomUUID(), partnerId: profile.id, payoutId: payout.id, earningId: e.id })) });
    await audit(tx, userId, 'RIDER_PAYOUT_REQUESTED', payout.id);
    return payout;
  });
}
export async function approveRiderPayout(req, id, why, db = prisma) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM rider_payouts WHERE id = ${id} FOR UPDATE`;
    const payout = await tx.riderPayout.findUnique({ where: { id }, include: { attempts: { orderBy: { number: 'desc' }, take: 1 } } });
    if (!payout) throw ccError('NOT_FOUND', 404, 'Payout not found.');
    if (payout.requestedByUserId === req.user.id) throw ccError('MAKER_CHECKER_REQUIRED', 403, 'Someone other than the requester must approve the payout.');
    if (!['REQUESTED', 'FAILED', 'REVERSED'].includes(payout.status)) throw ccError('INVALID_STATE', 409, 'This payout cannot be approved in its current state.');
    const last = payout.attempts[0];
    if (payout.status !== 'REQUESTED' && !['FAILED', 'REVERSED'].includes(last?.status)) throw ccError('RECONCILIATION_REQUIRED', 409, 'Reconcile the previous transfer before approving a retry.');
    const result = await tx.riderPayout.update({ where: { id }, data: { status: 'APPROVED', approvedByUserId: req.user.id, approvedAt: new Date(), providerErrorCode: null }, select: payoutSelect });
    await adminAudit(tx, req, { summary: 'Approved rider payout', resourceType: 'rider-payout', resourceId: id, reason: why, after: { amountMinor: payout.amountMinor, currency: 'NGN' } });
    return result;
  });
}
export async function submitRiderPayout(req, id, why, { db = prisma, gateway = provider } = {}) {
  if (!gateway.operationsConfigured()) throw ccError('PROVIDER_NOT_CONFIGURED', 503, 'Configure Paystack transfers before sending a payout. No money has been sent.');
  const lease = randomUUID();
  const prepared = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM rider_payouts WHERE id = ${id} FOR UPDATE`;
    const payout = await tx.riderPayout.findUnique({ where: { id }, include: { attempts: { orderBy: { number: 'desc' }, take: 1 } } });
    if (!payout || payout.status !== 'APPROVED' || !payout.approvedByUserId || payout.approvedByUserId === payout.requestedByUserId) throw ccError('INVALID_STATE', 409, 'An independently approved payout is required.');
    const n = (payout.attempts[0]?.number || 0) + 1;
    if (n > 10) throw ccError('RETRY_LIMIT', 409, 'Contact finance to investigate repeated transfer failures.');
    const attempt = await tx.riderTransferAttempt.create({ data: { id: randomUUID(), payoutId: id, number: n, reference: `srp-${randomUUID().replaceAll('-', '')}-${n}`, status: 'UNKNOWN', leaseToken: lease, leaseUntil: new Date(Date.now() + 60000), nextCheckAt: new Date(Date.now() + 60000) } });
    await tx.riderPayout.update({ where: { id }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
    await adminAudit(tx, req, { summary: 'Submitted rider payout to provider', resourceType: 'rider-payout', resourceId: id, reason: why, after: { attempt: n, amountMinor: payout.amountMinor } });
    return { payout, attempt };
  });
  let status = 'SUBMITTED', code = null, transferCode = null;
  try {
    const result = await gateway.sendTransfer({ amountMinor: prepared.payout.amountMinor, recipientCode: prepared.payout.recipientCode, reference: prepared.attempt.reference });
    if (result.reference !== prepared.attempt.reference || !/^TRF_[A-Za-z0-9]+$/.test(result.transfer_code || '')) throw Object.assign(new Error('Unexpected provider response'), { uncertain: true });
    transferCode = result.transfer_code; status = result.status === 'otp' ? 'NEEDS_PROVIDER_AUTH' : 'SUBMITTED';
  } catch (e) { status = e.uncertain === false ? 'FAILED' : 'UNKNOWN'; code = e.code || 'PROVIDER_UNCERTAIN'; }
  await db.$transaction(async (tx) => {
    const changed = await tx.riderTransferAttempt.updateMany({ where: { id: prepared.attempt.id, status: 'UNKNOWN', leaseToken: lease }, data: { status, providerTransferCode: transferCode, errorCode: code, leaseToken: null, leaseUntil: null, nextCheckAt: new Date(Date.now() + 60000) } });
    if (changed.count) await tx.riderPayout.update({ where: { id }, data: { status, providerTransferCode: transferCode, providerErrorCode: code } });
  });
  return db.riderPayout.findUnique({ where: { id }, select: payoutSelect });
}
export async function reconcileRiderTransfer(reference, { db = prisma, gateway = provider } = {}) {
  const attempt = await db.riderTransferAttempt.findUnique({ where: { reference }, include: { payout: true } });
  if (!attempt) throw ccError('NOT_FOUND', 404, 'Transfer not found.');
  if (attempt.leaseToken && attempt.leaseUntil > new Date()) throw ccError('TRANSFER_IN_PROGRESS', 409, 'The transfer request is still running. Please wait before reconciling.');
  const result = await gateway.verifyTransfer(reference);
  const recipient = typeof result.recipient === 'object' ? result.recipient?.recipient_code : null;
  if (result.reference !== reference || result.amount !== attempt.payout.amountMinor || result.currency !== 'NGN' || recipient !== attempt.payout.recipientCode) throw ccError('PROVIDER_MISMATCH', 409, 'Provider amount, currency or recipient did not match. The payout remains unconfirmed.');
  const status = { success: 'PAID', failed: 'FAILED', reversed: 'REVERSED', otp: 'NEEDS_PROVIDER_AUTH', pending: 'SUBMITTED', processing: 'SUBMITTED' }[result.status];
  if (!status) throw ccError('PROVIDER_UNCERTAIN', 503, 'The provider has not returned a conclusive transfer state.');
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM rider_payouts WHERE id = ${attempt.payoutId} FOR UPDATE`;
    const current = await tx.riderTransferAttempt.findUnique({ where: { reference } });
    if (current.status === 'PAID' && !['PAID', 'REVERSED'].includes(status)) throw ccError('PROVIDER_STATE_CONFLICT', 409, 'Provider state is inconsistent with an already verified payment.');
    if (current.status === 'REVERSED' && status !== 'REVERSED') throw ccError('PROVIDER_STATE_CONFLICT', 409, 'A reversed transfer cannot be changed by an older provider response.');
    const newerCallback = current.verificationRequested && current.nextCheckAt.getTime() !== attempt.nextCheckAt.getTime();
    const expected = { 'transfer.success': 'PAID', 'transfer.failed': 'FAILED', 'transfer.reversed': 'REVERSED' }[current.lastProviderEvent];
    const awaitingProvider = Boolean(expected && status !== expected);
    await tx.riderTransferAttempt.update({ where: { reference }, data: { status, providerTransferCode: result.transfer_code || current.providerTransferCode, errorCode: awaitingProvider ? 'AWAITING_PROVIDER_EVENT_CONFIRMATION' : null, leaseToken: null, leaseUntil: null, verificationRequested: newerCallback || awaitingProvider, nextCheckAt: newerCallback ? current.nextCheckAt : new Date(Date.now() + 300000) } });
    const latest = await tx.riderTransferAttempt.findFirst({ where: { payoutId: attempt.payoutId }, orderBy: { number: 'desc' } });
    const parent = await tx.riderPayout.findUnique({ where: { id: attempt.payoutId } });
    if (latest.id === current.id) await tx.riderPayout.update({ where: { id: attempt.payoutId }, data: { status, ...(status === 'PAID' && !parent.paidAt ? { paidAt: new Date() } : {}), providerErrorCode: null } });
    const paidCount = await tx.riderTransferAttempt.count({ where: { payoutId: attempt.payoutId, status: 'PAID' } });
    if (paidCount > 1) await tx.riderPayout.update({ where: { id: attempt.payoutId }, data: { providerErrorCode: 'MULTIPLE_PAID_ATTEMPTS' } });
    if (current.status !== status) await audit(tx, attempt.payout.requestedByUserId, `RIDER_TRANSFER_${status}`, attempt.payoutId);
  });
  return db.riderPayout.findUnique({ where: { id: attempt.payoutId }, select: payoutSelect });
}
export async function finalizeRiderPayout(req, id, otp, why, { db = prisma, gateway = provider } = {}) {
  const payout = await db.riderPayout.findUnique({ where: { id }, include: { attempts: { orderBy: { number: 'desc' }, take: 1 } } });
  const attempt = payout?.attempts[0];
  if (payout?.status !== 'NEEDS_PROVIDER_AUTH' || !attempt?.providerTransferCode || !payout.approvedByUserId) throw ccError('INVALID_STATE', 409, 'This transfer is not awaiting provider authorisation.');
  await gateway.finalizeTransfer({ transferCode: attempt.providerTransferCode, otp });
  await db.$transaction(async (tx) => {
    await tx.riderTransferAttempt.updateMany({ where: { id: attempt.id, status: 'NEEDS_PROVIDER_AUTH' }, data: { status: 'SUBMITTED', nextCheckAt: new Date() } });
    await adminAudit(tx, req, { summary: 'Authorised rider transfer with provider', resourceType: 'rider-payout', resourceId: id, reason: why });
  });
  return { id, status: 'SUBMITTED' };
}
export async function queueRiderTransferVerification(event, db = prisma) {
  const reference = event?.data?.reference;
  if (!['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event?.event) || typeof reference !== 'string' || !reference.startsWith('srp-')) return { ignored: true };
  const changed = await db.riderTransferAttempt.updateMany({ where: { reference, ...(event.event === 'transfer.reversed' ? {} : { OR: [{ lastProviderEvent: null }, { lastProviderEvent: { not: 'transfer.reversed' } }] }) }, data: { nextCheckAt: new Date(), verificationRequested: true, lastProviderEvent: event.event } });
  return changed.count ? { queued: true } : { ignored: true };
}
export async function runRiderTransferReconciliationOnce({ db = prisma, gateway = provider } = {}) {
  if (!gateway.operationsConfigured()) return 0;
  const rows = await db.riderTransferAttempt.findMany({ where: { AND: [{ OR: [{ status: { in: ['SUBMITTED', 'UNKNOWN', 'NEEDS_PROVIDER_AUTH'] } }, { verificationRequested: true }] }, { OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }], nextCheckAt: { lte: new Date() } }, orderBy: { nextCheckAt: 'asc' }, take: 1 });
  for (const row of rows) {
    // Preserve the compare-and-set claim and provider retry delay in both hosts.
    const claimed = await db.riderTransferAttempt.updateMany({ where: { id: row.id, nextCheckAt: row.nextCheckAt }, data: { nextCheckAt: new Date(Date.now() + 300000) } });
    if (!claimed.count) continue;
    try { await reconcileRiderTransfer(row.reference, { db, gateway }); }
    catch (e) { await db.riderTransferAttempt.update({ where: { id: row.id }, data: { errorCode: e.code || 'RECONCILIATION_UNAVAILABLE' } }); }
  }
  return rows.length;
}
export function startRiderTransferReconciler() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !provider.operationsConfigured()) return;
    busy = true;
    try {
      await runRiderTransferReconciliationOnce();
    } catch { console.error('[rider-payouts] Reconciliation unavailable; no payout is marked paid.'); }
    finally { busy = false; }
  }, 15000);
  timer.unref?.(); return () => clearInterval(timer);
}
