import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import prisma from '../../config/db.js';
import { adminAudit, ccError } from './cc.common.js';
import * as paystack from '../payments/paystack.operations.js';

export const invoiceSelect = { id: true, organizationId: true, reference: true, packageName: true, cycle: true, amountMinor: true, currency: true, periodStart: true, periodEnd: true, dueAt: true, status: true, paidAt: true, voidedAt: true, voidReason: true, createdAt: true, payment: { select: { reference: true, status: true, errorCode: true, verifiedAt: true } } };
export function periodEnd(start, cycle) {
  const d = new Date(start), day = d.getUTCDate();
  d.setUTCDate(1);
  if (cycle === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return d;
}
export function emrPortalUrl(path = '/') {
  const origin = new URL(process.env.EMR_PORTAL_URL || 'https://emr.sabihealth.org');
  if (origin.protocol !== 'https:' || origin.username || origin.password) throw ccError('PORTAL_CONFIG', 503, 'Configure the secure EMR portal address.');
  return new URL(path, origin.origin).toString();
}
export async function queueInvoiceEmail(tx, invoice, kind) {
  const organization = await tx.identityOrganization.findUnique({ where: { id: invoice.organizationId }, select: { organisation: { select: { owner: { select: { email: true, emailVerifiedAt: true, accountStatus: true } } } } } });
  const owner = organization?.organisation?.owner;
  if (!owner?.email || !owner.emailVerifiedAt || owner.accountStatus !== 'ACTIVE') return null;
  const amount = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(invoice.amountMinor / 100);
  const message = `${kind === 'PAID' ? 'Payment has been confirmed for' : 'A Sabi OS subscription invoice is ready:'} ${invoice.reference}.\nPackage: ${invoice.packageName}\nAmount: ${amount}\nPeriod: ${invoice.periodStart.toISOString().slice(0, 10)} to ${invoice.periodEnd.toISOString().slice(0, 10)} (end exclusive).\n\nSign in to your organisation to ${kind === 'PAID' ? 'view your receipt' : 'review and pay securely'}:\n${emrPortalUrl('/subscription')}\n\nWe never ask for your password by email.`;
  return tx.subscriptionEmailJob.upsert({ where: { invoiceId_kind: { invoiceId: invoice.id, kind } }, create: { invoiceId: invoice.id, kind, recipient: owner.email, subject: kind === 'PAID' ? 'Sabi OS subscription payment receipt' : 'Your Sabi OS subscription invoice', message }, update: {} });
}
export async function createSubscriptionInvoice(req, data, db = prisma) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM identity_organizations WHERE id = ${data.organizationId} FOR UPDATE`;
    const prior = await tx.subscriptionInvoice.findUnique({ where: { requestKey: data.requestKey }, select: invoiceSelect });
    if (prior) {
      if (prior.organizationId !== data.organizationId || prior.periodStart.toISOString().slice(0, 10) !== data.periodStart || prior.dueAt.toISOString().slice(0, 10) !== data.dueAt) throw ccError('IDEMPOTENCY_CONFLICT', 409, 'That reference belongs to a different invoice request.');
      return prior;
    }
    const org = await tx.identityOrganization.findUnique({ where: { id: data.organizationId }, select: { organisationId: true, organisation: { select: { status: true } } } });
    const app = org?.organisationId && await tx.platformApplication.findFirst({ where: { approvedOrganisationId: org.organisationId, status: 'APPROVED', setupCompletedAt: { not: null } }, include: { packageVersion: true, package: { select: { name: true } } } });
    if (!app || org.organisation.status !== 'VERIFIED') throw ccError('CUSTOMER_NOT_READY', 409, 'An approved, activated hospital subscription is required.');
    const cycle = app.billingCycle.toLowerCase();
    if (!['monthly', 'annual'].includes(cycle)) throw ccError('INVALID_CYCLE', 409, 'This customer’s accepted billing cycle needs review.');
    const amount = cycle === 'annual' ? app.packageVersion.annualPriceMinor : app.packageVersion.monthlyPriceMinor;
    if (app.packageVersion.currency !== 'NGN' || !Number.isSafeInteger(amount) || amount <= 0) throw ccError('INVALID_PRICE', 409, 'The accepted package must have a positive NGN price. Free packages are not charged.');
    const start = new Date(`${data.periodStart}T00:00:00Z`), end = periodEnd(start, cycle);
    if (await tx.subscriptionInvoice.count({ where: { organizationId: data.organizationId, status: { not: 'VOID' }, periodStart: { lt: end }, periodEnd: { gt: start } } })) throw ccError('PERIOD_OVERLAP', 409, 'This customer already has an invoice for an overlapping period.');
    const invoice = await tx.subscriptionInvoice.create({ data: { organizationId: data.organizationId, applicationId: app.id, packageVersionId: app.packageVersionId, packageName: app.package.name, cycle, amountMinor: amount, reference: `SSI-${randomUUID().slice(0, 8).toUpperCase()}`, requestKey: data.requestKey, periodStart: start, periodEnd: end, dueAt: new Date(`${data.dueAt}T00:00:00Z`), createdByUserId: req.user.id } });
    await queueInvoiceEmail(tx, invoice, 'ISSUED');
    await adminAudit(tx, req, { summary: 'Issued subscription invoice from accepted package', resourceType: 'subscription-invoice', resourceId: invoice.id, reason: data.reason, after: { amountMinor: amount, currency: 'NGN', packageVersionId: app.packageVersionId, periodStart: data.periodStart } });
    return tx.subscriptionInvoice.findUnique({ where: { id: invoice.id }, select: invoiceSelect });
  });
}
export async function voidSubscriptionInvoice(req, id, reason, db = prisma) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM subscription_invoices WHERE id = ${id} FOR UPDATE`;
    const invoice = await tx.subscriptionInvoice.findUnique({ where: { id }, include: { payment: true } });
    if (!invoice) throw ccError('NOT_FOUND', 404, 'Invoice not found.');
    if (invoice.status !== 'OPEN' || invoice.payment) throw ccError('INVOICE_NOT_VOIDABLE', 409, 'Only an unpaid invoice without a payment attempt can be voided. Reconcile any attempted payment first.');
    await tx.subscriptionInvoice.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: reason } });
    await tx.subscriptionEmailJob.updateMany({ where: { invoiceId: id, status: 'QUEUED' }, data: { status: 'FAILED', lastErrorCode: 'INVOICE_VOID' } });
    await adminAudit(tx, req, { summary: 'Voided unpaid subscription invoice', resourceType: 'subscription-invoice', resourceId: id, reason });
    return tx.subscriptionInvoice.findUnique({ where: { id }, select: invoiceSelect });
  });
}
const checkoutUrl = (value) => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'checkout.paystack.com' && !u.username && !u.password ? u.toString() : null; } catch { return null; } };
export async function startSubscriptionPayment(organizationId, invoiceId, { db = prisma, gateway = paystack } = {}) {
  if (!gateway.operationsConfigured()) throw ccError('PROVIDER_NOT_CONFIGURED', 503, 'The payment provider is not configured. No payment has been charged.');
  const lease = randomUUID();
  const prepared = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM subscription_invoices WHERE id = ${invoiceId} FOR UPDATE`;
    const invoice = await tx.subscriptionInvoice.findFirst({ where: { id: invoiceId, organizationId }, include: { payment: true } });
    if (!invoice) throw ccError('NOT_FOUND', 404, 'Invoice not found.');
    if (invoice.status !== 'OPEN') throw ccError('INVOICE_NOT_OPEN', 409, 'This invoice is already paid or voided.');
    if (invoice.payment?.checkoutUrl && invoice.payment.status === 'READY') return { url: invoice.payment.checkoutUrl, reference: invoice.payment.reference };
    if (invoice.payment && invoice.payment.status !== 'CREATED') throw ccError('RECONCILIATION_REQUIRED', 409, 'A payment attempt already exists. Check its status before trying again; no second payment reference will be created.');
    const owner = await tx.identityOrganization.findUnique({ where: { id: organizationId }, select: { organisation: { select: { owner: { select: { email: true, emailVerifiedAt: true, accountStatus: true } } } } } });
    const user = owner?.organisation?.owner;
    if (!user?.email || !user.emailVerifiedAt || user.accountStatus !== 'ACTIVE') throw ccError('VERIFIED_OWNER_REQUIRED', 409, 'A verified active owner email is required for payment.');
    const fields = { status: 'INITIALIZING', leaseToken: lease, leaseUntil: new Date(Date.now() + 60000), nextCheckAt: new Date(Date.now() + 60000) };
    const payment = await tx.subscriptionPayment.upsert({ where: { invoiceId }, create: { invoiceId, reference: `ssi-${randomUUID().replaceAll('-', '')}`, ...fields }, update: fields });
    return { invoice, payment, email: user.email };
  });
  if (prepared.url) return prepared;
  try {
    const result = await gateway.initializeCharge({ email: prepared.email, amountMinor: prepared.invoice.amountMinor, reference: prepared.payment.reference, callbackUrl: emrPortalUrl('/subscription') });
    const url = checkoutUrl(result.authorization_url);
    if (!url || result.reference !== prepared.payment.reference) throw ccError('PROVIDER_INVALID_RESPONSE', 503, 'Provider checkout could not be validated. Check payment status before trying again.');
    const changed = await db.subscriptionPayment.updateMany({ where: { id: prepared.payment.id, status: 'INITIALIZING', leaseToken: lease }, data: { status: 'READY', checkoutUrl: url, leaseToken: null, leaseUntil: null, errorCode: null } });
    if (!changed.count) throw ccError('PAYMENT_CHANGED', 409, 'Payment status changed during checkout. Refresh the invoice.');
    return { url, reference: prepared.payment.reference };
  } catch (e) {
    await db.subscriptionPayment.updateMany({ where: { id: prepared.payment.id, status: 'INITIALIZING', leaseToken: lease }, data: { status: 'UNKNOWN', leaseToken: null, leaseUntil: null, errorCode: e.code || 'PROVIDER_UNAVAILABLE', nextCheckAt: new Date(Date.now() + 60000) } });
    throw e;
  }
}
export async function reconcileSubscription(reference, { db = prisma, gateway = paystack } = {}) {
  const payment = await db.subscriptionPayment.findUnique({ where: { reference }, include: { invoice: true } });
  if (!payment) throw ccError('NOT_FOUND', 404, 'Subscription payment not found.');
  let verified;
  try { verified = await gateway.verifyCharge(reference); }
  catch (e) {
    if (e.code === 'PROVIDER_REFERENCE_NOT_FOUND' && payment.status === 'UNKNOWN' && (!payment.leaseUntil || payment.leaseUntil <= new Date())) {
      // Re-use the SAME provider reference after a confirmed missing initialization. Never
      // create a new reference merely because the first network request timed out.
      await db.subscriptionPayment.updateMany({ where: { id: payment.id, status: 'UNKNOWN', invoice: { status: 'OPEN' } }, data: { status: 'CREATED', errorCode: null } });
      return db.subscriptionInvoice.findUnique({ where: { id: payment.invoiceId }, select: invoiceSelect });
    }
    throw e;
  }
  if (verified.reference !== reference || verified.amount !== payment.invoice.amountMinor || verified.currency !== 'NGN') throw ccError('PROVIDER_MISMATCH', 409, 'Provider amount, currency or reference did not match. The invoice remains unconfirmed.');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM subscription_invoices WHERE id = ${payment.invoiceId} FOR UPDATE`;
    const invoice = await tx.subscriptionInvoice.findUnique({ where: { id: payment.invoiceId } });
    if (verified.status === 'success' && invoice.status === 'OPEN') {
      const now = new Date();
      const paid = await tx.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: 'PAID', paidAt: now } });
      await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { status: 'PAID', verifiedAt: now, errorCode: null, leaseToken: null, leaseUntil: null } });
      await queueInvoiceEmail(tx, paid, 'PAID');
      await tx.activityLog.create({ data: { userId: invoice.createdByUserId, type: 'SUBSCRIPTION_PAYMENT_VERIFIED', description: 'Subscription payment independently verified', meta: { invoiceId: invoice.id, reference } } });
    } else if (invoice.status === 'OPEN') await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { errorCode: verified.status === 'failed' || verified.status === 'abandoned' ? 'PROVIDER_NOT_PAID' : null, nextCheckAt: new Date(Date.now() + 300000) } });
    return tx.subscriptionInvoice.findUnique({ where: { id: invoice.id }, select: invoiceSelect });
  });
}
export async function subscriptionWebhook(event, db = prisma) {
  if (event?.event !== 'charge.success' || !event?.data?.reference?.startsWith('ssi-')) return { ignored: true };
  // Signed callback only queues independent verification; it cannot change a paid balance itself.
  const changed = await db.subscriptionPayment.updateMany({ where: { reference: event.data.reference, status: { not: 'PAID' } }, data: { nextCheckAt: new Date() } });
  return changed.count ? { queued: true } : { ignored: true };
}
