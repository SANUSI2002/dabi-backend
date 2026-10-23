import { randomUUID } from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';
import prisma from '../../config/db.js';
import { passwordResetEmailConfigured, passwordResetEmailAllowedFor } from '../auth/auth.email.js';
import { reconcileSubscription } from './subscriptions.service.js';
import { operationsConfigured } from '../payments/paystack.operations.js';

export async function sendSubscriptionMail({ db = prisma, fetcher = globalThis.fetch, now = new Date() } = {}) {
  if (!passwordResetEmailConfigured()) return false;
  const job = await db.subscriptionEmailJob.findFirst({ where: { attempts: { lt: 5 }, nextAttemptAt: { lte: now }, OR: [{ status: 'QUEUED' }, { status: 'SENDING', leaseUntil: { lt: now } }] }, orderBy: { nextAttemptAt: 'asc' } });
  if (!job) return false;
  const lease = randomUUID(), first = job.firstAttemptAt || now;
  const claim = await db.subscriptionEmailJob.updateMany({ where: { id: job.id, attempts: job.attempts, OR: [{ status: 'QUEUED' }, { status: 'SENDING', leaseUntil: { lt: now } }] }, data: { status: 'SENDING', attempts: { increment: 1 }, leaseToken: lease, leaseUntil: new Date(now.getTime() + 60000), firstAttemptAt: first } });
  if (!claim.count) return false;
  let errorCode;
  const invoice = await db.subscriptionInvoice.findUnique({ where: { id: job.invoiceId }, select: { organizationId: true, status: true } });
  const organization = invoice && await db.identityOrganization.findUnique({ where: { id: invoice.organizationId }, select: { organisation: { select: { owner: { select: { email: true, emailVerifiedAt: true, accountStatus: true } } } } } });
  const owner = organization?.organisation?.owner;
  if (invoice?.status === 'VOID') errorCode = 'INVOICE_VOID';
  else if (!owner || owner.accountStatus !== 'ACTIVE' || !owner.emailVerifiedAt || owner.email?.toLowerCase() !== job.recipient.toLowerCase()) errorCode = 'RECIPIENT_CHANGED';
  // No retries after the provider's 24 h idempotency window: keep uncertain mail for review.
  else if (now - first > 23 * 3600000) errorCode = 'IDEMPOTENCY_WINDOW_EXPIRED';
  else if (!passwordResetEmailAllowedFor(job.recipient)) errorCode = 'RECIPIENT_NOT_ALLOWED';
  else try {
    const response = await fetcher('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: globalThis.AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `subscription-mail-${job.id}` }, body: JSON.stringify({ from: process.env.PASSWORD_RESET_EMAIL_FROM, to: [job.recipient], subject: job.subject, text: job.message }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.id) errorCode = 'EMAIL_PROVIDER_REJECTED';
  } catch { errorCode = 'EMAIL_PROVIDER_UNAVAILABLE'; }
  await db.subscriptionEmailJob.updateMany({ where: { id: job.id, status: 'SENDING', leaseToken: lease }, data: { status: !errorCode ? 'SENT' : job.attempts >= 4 || ['IDEMPOTENCY_WINDOW_EXPIRED', 'RECIPIENT_NOT_ALLOWED', 'RECIPIENT_CHANGED', 'INVOICE_VOID'].includes(errorCode) ? 'FAILED' : 'QUEUED', leaseToken: null, leaseUntil: null, lastErrorCode: errorCode || null, ...(errorCode ? { nextAttemptAt: new Date(now.getTime() + 60000 * 2 ** job.attempts) } : { sentAt: now }) } });
  return true;
}
export async function pruneTracking(db = prisma, now = new Date()) {
  const settings = await db.platformRuntimeSettings.findUnique({ where: { id: 'default' } });
  const before = new Date(now.getTime() - (settings?.trackingRetentionDays || 30) * 86400000);
  const rows = await db.deliveryTrackingPoint.findMany({ where: { recordedAt: { lt: before }, assignment: { status: { in: ['COMPLETED', 'REJECTED'] } } }, select: { id: true }, take: 1000 });
  if (rows.length) await db.deliveryTrackingPoint.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, recordedAt: { lt: before } } });
  await db.deliveryPartner.updateMany({ where: { OR: [{ isAvailable: false }, { availableUntil: { lte: now } }], locationUpdatedAt: { lt: new Date(now.getTime() - 86400000) } }, data: { lastLatitude: null, lastLongitude: null, locationAccuracyMeters: null, locationUpdatedAt: null } });
  return rows.length;
}
export async function reconcileSubscriptionOnce({ db = prisma, reconcile = reconcileSubscription, configured = operationsConfigured } = {}) {
  if (!configured()) return false;
  const row = await db.subscriptionPayment.findFirst({ where: { status: { in: ['INITIALIZING', 'UNKNOWN', 'READY'] }, nextCheckAt: { lte: new Date() }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, orderBy: { nextCheckAt: 'asc' } });
  if (!row) return false;
  const changed = await db.subscriptionPayment.updateMany({ where: { id: row.id, nextCheckAt: row.nextCheckAt }, data: { nextCheckAt: new Date(Date.now() + 300000) } });
  if (!changed.count) return false;
  try { await reconcile(row.reference); } catch (e) { await db.subscriptionPayment.updateMany({ where: { id: row.id, status: { not: 'PAID' } }, data: { errorCode: e.code || 'PROVIDER_UNAVAILABLE' } }); }
  return true;
}
export function startRuntimeWorker() {
  let busy = false, lastPruned = 0;
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      await sendSubscriptionMail();
      await reconcileSubscriptionOnce();
      if (Date.now() - lastPruned > 3600000) { await pruneTracking(); lastPruned = Date.now(); }
    } catch { console.error('[platform-runtime] Queue temporarily unavailable; jobs remain persisted.'); }
    finally { busy = false; }
  }, 15000);
  timer.unref?.(); return () => clearInterval(timer);
}
