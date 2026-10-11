// /api/v1/command-centre/ops — background jobs, integrations and alerts.
//
// Integrations report whether each one is configured, sandboxed or off, and their recent activity —
// never a key, token or secret, and never the content of a message (a notification is shown by its
// category and event type, not its text, which can be clinical). Retrying a failed job needs
// platform.jobs.manage and a reason, is limited to job types where a late send is still safe, and is
// audited.
import { Buffer } from 'node:buffer';
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { configured as paystackConfigured } from '../payments/paystack.adapter.js';
import { roadRoutingConfigured } from '../checkout-pricing/distance.js';
import { whatsappConfig } from '../whatsapp/whatsapp.provider.js';
import { pushConfig } from '../notifications/push.service.js';
import { dailyConfigured } from '../doctor-video/daily.provider.js';
import { withWorker } from '../emr/core/db.js';
import { adminAudit, allow, ccError, handle, maskEmail, namesFor, pageQuery, paged, reason } from './cc.common.js';

export const opsRoutes = express.Router();

const none = z.object({}).strict();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const READ = ['platform.ops.read', 'platform.jobs.manage'];

// ------------------------------------------------------------------------------------------------
// Integrations
// ------------------------------------------------------------------------------------------------
function deliveryKeyValid() {
  const configured = process.env.ORDER_DELIVERY_ENCRYPTION_KEY;
  return Boolean(configured) && Buffer.from(configured, 'base64').length === 32;
}

export async function integrations(now = new Date()) {
  const day = new Date(now - DAY);
  const [webhooks, lastWebhook, channels] = await Promise.all([
    prisma.paymentWebhookReceipt.groupBy({ by: ['outcome'], where: { receivedAt: { gte: day } }, _count: { _all: true } }),
    prisma.paymentWebhookReceipt.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true, outcome: true } }),
    prisma.notificationDelivery.groupBy({ by: ['channel', 'status'], where: { updatedAt: { gte: day } }, _count: { _all: true } }),
  ]);
  const channel = (name) => Object.fromEntries(channels.filter((c) => c.channel === name).map((c) => [c.status, c._count._all]));
  const wa = whatsappConfig();
  const waReady = wa.provider === 'cloud' ? Boolean(wa.phoneNumberId && wa.accessToken && wa.appSecret) : wa.provider === 'simulator';
  const item = (key, name, purpose, status, detail, activity = null) => ({ key, name, purpose, status, detail, activity });
  const webhookCounts = Object.fromEntries(webhooks.map((w) => [w.outcome, w._count._all]));
  return [
    item('paystack', 'Paystack', 'Card and bank payments, refunds', paystackConfigured() ? ((webhookCounts.REJECTED_SIGNATURE ?? 0) > 0 ? 'DEGRADED' : 'CONFIGURED') : 'NOT_CONFIGURED',
      paystackConfigured() ? ((webhookCounts.REJECTED_SIGNATURE ?? 0) > 0 ? `${webhookCounts.REJECTED_SIGNATURE} webhook(s) with a bad signature in 24 h` : 'Secret key present on the server') : 'PAYSTACK_SECRET_KEY is not set: checkout payments and refunds are unavailable.',
      { webhooks24h: webhookCounts, lastWebhookAt: lastWebhook?.receivedAt ?? null }),
    item('whatsapp', 'WhatsApp (Meta Cloud API)', 'Reminders and updates by WhatsApp', !wa.provider ? 'NOT_CONFIGURED' : wa.provider === 'simulator' ? 'SANDBOX' : waReady ? 'CONFIGURED' : 'DEGRADED',
      !wa.provider ? 'WhatsApp is off; patients get in-app notifications only.' : wa.provider === 'simulator' ? 'Local simulator: nothing reaches a real phone.' : waReady ? 'Cloud API credentials present' : 'Cloud API selected but credentials are incomplete.',
      { last24h: channel('WHATSAPP') }),
    item('push', 'Web push', 'Notifications on installed devices', pushConfig().enabled ? 'CONFIGURED' : 'NOT_CONFIGURED', pushConfig().enabled ? 'VAPID keys present' : 'WEB_PUSH keys are not set.', { last24h: channel('PUSH') }),
    item('email', 'Email (Resend)', 'Password reset, pharmacy and onboarding emails', process.env.RESEND_API_KEY ? (process.env.RESEND_TEST_RECIPIENT ? 'SANDBOX' : 'CONFIGURED') : 'NOT_CONFIGURED',
      process.env.RESEND_API_KEY ? (process.env.RESEND_TEST_RECIPIENT ? 'Test mode: email only goes to the configured test recipient.' : 'API key present') : 'RESEND_API_KEY is not set: emails are not sent.', { last24h: channel('EMAIL') }),
    item('video', 'Daily video', 'Video consultations', dailyConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED', dailyConfigured() ? 'Enabled and processing approved' : 'Video consultations are off (needs DAILY_* settings and processing approval).'),
    item('scanning', 'Cloudmersive malware scanning', 'Scans uploaded documents and credentials', process.env.CLOUDMERSIVE_API_KEY ? 'CONFIGURED' : 'NOT_CONFIGURED', process.env.CLOUDMERSIVE_API_KEY ? 'API key present' : 'Uploads wait in quarantine until scanning is configured.'),
    item('routing', 'Google Routes', 'Road distance for delivery pricing', roadRoutingConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED', roadRoutingConfigured() ? 'API key present' : 'Delivery pricing uses straight-line distance only.'),
    item('delivery-encryption', 'Delivery address encryption', 'Encrypts patient delivery addresses at rest', deliveryKeyValid() ? 'CONFIGURED' : 'NOT_CONFIGURED', deliveryKeyValid() ? '256-bit key present' : 'Delivery orders cannot be placed without a valid ORDER_DELIVERY_ENCRYPTION_KEY.'),
  ];
}

opsRoutes.get('/integrations', allow(...READ), validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => ({ generatedAt: new Date().toISOString(), items: await integrations() })));

// ------------------------------------------------------------------------------------------------
// Jobs
// ------------------------------------------------------------------------------------------------
const JOB_TYPES = ['notification', 'reminder', 'pharmacy-email', 'emr-webhook'];

async function jobSummary(now = new Date()) {
  const day = new Date(now - DAY);
  const [notifications, reminders, emails, emr] = await Promise.all([
    prisma.notificationDelivery.groupBy({ by: ['status'], where: { updatedAt: { gte: day } }, _count: { _all: true } }),
    prisma.reminderJob.groupBy({ by: ['status'], where: { updatedAt: { gte: day } }, _count: { _all: true } }),
    prisma.pharmacyEmailJob.groupBy({ by: ['status'], _count: { _all: true } }),
    withWorker(async (tx) => ({
      deliveries: await tx.emrWebhookDelivery.groupBy({ by: ['status'], _count: { _all: true } }),
      oldestPendingOutbox: await tx.emrOutboxEvent.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      pendingOutbox: await tx.emrOutboxEvent.count({ where: { status: 'PENDING' } }),
    })),
  ]);
  const fold = (rows) => Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  return {
    notification: { window: 'last 24 h', counts: fold(notifications), retryable: true },
    reminder: { window: 'last 24 h', counts: fold(reminders), retryable: false, note: 'Medicine reminders are time-specific; a failed one is not re-sent late.' },
    'pharmacy-email': { window: 'all time', counts: fold(emails), retryable: true },
    'emr-webhook': { window: 'all time', counts: fold(emr.deliveries), retryable: true, outbox: { pending: emr.pendingOutbox, oldestPendingAt: emr.oldestPendingOutbox?.createdAt ?? null } },
  };
}

opsRoutes.get('/jobs/summary', allow(...READ), validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => ({ generatedAt: new Date().toISOString(), types: await jobSummary() })));

opsRoutes.get('/jobs', allow(...READ),
  validate(z.object({ query: z.object({ type: z.enum(JOB_TYPES), status: z.string().regex(/^[A-Z_]{2,20}$/).optional(), ...pageQuery }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const { type, status, page, limit } = req.query;
    const skip = (page - 1) * limit;
    if (type === 'notification') {
      const where = status ? { status } : {};
      const [rows, total] = await Promise.all([
        prisma.notificationDelivery.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip, take: limit, select: { id: true, userId: true, channel: true, status: true, attempts: true, lastError: true, createdAt: true, updatedAt: true, sentAt: true, deliveredAt: true, notification: { select: { category: true, eventType: true, createdAt: true } } } }),
        prisma.notificationDelivery.count({ where }),
      ]);
      const names = await namesFor(prisma, rows.map((r) => r.userId));
      return paged(rows.map((r) => ({ ...r, recipient: names.get(r.userId), category: r.notification.category, eventType: r.notification.eventType, notification: undefined, retryable: r.status === 'FAILED' && Date.now() - r.notification.createdAt.getTime() < DAY })), total, { page, limit });
    }
    if (type === 'reminder') {
      const where = status ? { status } : {};
      const [rows, total] = await Promise.all([
        prisma.reminderJob.findMany({ where, orderBy: [{ dueAt: 'desc' }, { id: 'desc' }], skip, take: limit, select: { id: true, userId: true, status: true, dueAt: true, originalDueAt: true, snoozeCount: true, lastError: true, processedAt: true } }),
        prisma.reminderJob.count({ where }),
      ]);
      const names = await namesFor(prisma, rows.map((r) => r.userId));
      return paged(rows.map((r) => ({ ...r, recipient: names.get(r.userId), retryable: false })), total, { page, limit });
    }
    if (type === 'pharmacy-email') {
      const where = status ? { status } : {};
      const [rows, total] = await Promise.all([
        prisma.pharmacyEmailJob.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: limit, select: { id: true, kind: true, status: true, recipient: true, attempts: true, lastErrorCode: true, createdAt: true, sentAt: true, nextAttemptAt: true, pharmacy: { select: { id: true, name: true } } } }),
        prisma.pharmacyEmailJob.count({ where }),
      ]);
      return paged(rows.map((r) => ({ ...r, recipient: maskEmail(r.recipient), retryable: r.status === 'FAILED' && r.lastErrorCode !== 'RECIPIENT_NOT_ALLOWED' })), total, { page, limit });
    }
    // EMR webhooks: read in the worker context (tenant row-level security allows deliveries only).
    const { rows, total } = await withWorker(async (tx) => {
      const where = status ? { status } : {};
      return { rows: await tx.emrWebhookDelivery.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: limit, select: { id: true, organizationId: true, subscriptionId: true, eventId: true, status: true, attempts: true, lastStatusCode: true, lastError: true, createdAt: true, deliveredAt: true, nextAttemptAt: true } }), total: await tx.emrWebhookDelivery.count({ where }) };
    });
    const orgs = new Map((await prisma.identityOrganization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } }, select: { id: true, organisation: { select: { name: true } }, pharmacy: { select: { name: true } } } })).map((o) => [o.id, o.organisation?.name ?? o.pharmacy?.name ?? null]));
    return paged(rows.map((r) => ({ ...r, organization: orgs.get(r.organizationId) ?? null, retryable: r.status === 'DEAD' })), total, { page, limit });
  }));

opsRoutes.post('/jobs/:type/:id/retry', allow('platform.jobs.manage'),
  validate(z.object({ body: z.object({ reason }).strict(), query: none, params: z.object({ type: z.enum(JOB_TYPES), id: z.string().uuid() }).strict() })),
  handle(async (req) => {
    const { type, id } = req.params;
    const now = new Date();
    const audit = (tx, summary) => adminAudit(tx, req, { summary, resourceType: `job:${type}`, resourceId: id, reason: req.body.reason, after: { status: 'RETRY_QUEUED' } });
    if (type === 'reminder') throw ccError('NOT_RETRYABLE', 409, 'Medicine reminders are time-specific and are not re-sent late.');
    if (type === 'notification') {
      return prisma.$transaction(async (tx) => {
        const d = await tx.notificationDelivery.findUnique({ where: { id }, select: { id: true, status: true, notification: { select: { createdAt: true } } } });
        if (!d) throw ccError('NOT_FOUND', 404, 'Notification delivery not found.');
        if (d.status !== 'FAILED') throw ccError('INVALID_STATE', 409, 'Only a failed delivery can be retried.');
        if (now - d.notification.createdAt >= DAY) throw ccError('NOT_RETRYABLE', 409, 'This notification is over a day old; sending it now could mislead the patient.');
        const changed = await tx.notificationDelivery.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: now, lastError: null } });
        if (!changed.count) throw ccError('INVALID_STATE', 409, 'This delivery changed; refresh.');
        await audit(tx, 'Queued a failed notification for another attempt');
        return { id, status: 'PENDING' };
      });
    }
    if (type === 'pharmacy-email') {
      return prisma.$transaction(async (tx) => {
        const j = await tx.pharmacyEmailJob.findUnique({ where: { id }, select: { status: true, lastErrorCode: true } });
        if (!j) throw ccError('NOT_FOUND', 404, 'Email job not found.');
        if (j.status !== 'FAILED') throw ccError('INVALID_STATE', 409, 'Only a failed email can be retried.');
        if (j.lastErrorCode === 'RECIPIENT_NOT_ALLOWED') throw ccError('NOT_RETRYABLE', 409, 'This recipient is not allowed by the email configuration; retrying would fail again.');
        const changed = await tx.pharmacyEmailJob.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'QUEUED', attempts: 0, firstAttemptAt: null, nextAttemptAt: now, lastErrorCode: null } });
        if (!changed.count) throw ccError('INVALID_STATE', 409, 'This job changed; refresh.');
        await audit(tx, 'Queued a failed pharmacy email for another attempt');
        return { id, status: 'QUEUED' };
      });
    }
    const result = await withWorker(async (tx) => {
      const changed = await tx.emrWebhookDelivery.updateMany({ where: { id, status: 'DEAD' }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: now, lastError: null } });
      return changed.count;
    });
    if (!result) throw ccError('INVALID_STATE', 409, 'Only a webhook delivery that was given up can be retried.');
    await audit(prisma, 'Queued a dead EMR webhook delivery for another attempt');
    return { id, status: 'PENDING' };
  }));

// ------------------------------------------------------------------------------------------------
// Alerts: rules evaluated on read, each with a severity, evidence and where to act.
// ------------------------------------------------------------------------------------------------
opsRoutes.get('/alerts', allow('platform.ops.read', 'platform.audit.read', 'platform.jobs.manage'),
  validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const now = new Date();
    const hour = new Date(now - HOUR);
    const day = new Date(now - DAY);
    const [heavyViewers, emergencies, failedSignIns, failedNotifications, badSignatures, integrationList, licences] = await Promise.all([
      prisma.auditEvent.groupBy({ by: ['actorUserId'], where: { action: { in: ['ADMIN_PATIENT_VIEWED', 'ADMIN_CLINICAL_VIEWED'] }, createdAt: { gte: hour } }, _count: { _all: true }, having: { actorUserId: { _count: { gt: 20 } } } }),
      prisma.emergencyAccessGrant.findMany({ where: { startedAt: { gte: day } }, select: { id: true, actorUserId: true, startedAt: true, reviewedAt: true } }),
      prisma.auditEvent.groupBy({ by: ['actorUserId'], where: { action: 'SIGN_IN_FAILED', createdAt: { gte: hour } }, _count: { _all: true }, having: { actorUserId: { _count: { gte: 5 } } } }),
      prisma.notificationDelivery.count({ where: { status: 'FAILED', updatedAt: { gte: hour } } }),
      prisma.paymentWebhookReceipt.count({ where: { outcome: 'REJECTED_SIGNATURE', receivedAt: { gte: day } } }),
      integrations(now),
      prisma.pharmacy.count({ where: { complianceStatus: 'VERIFIED', superintendentLicenceExpiresAt: { lt: new Date(now.getTime() + 14 * DAY) } } }),
    ]);
    const names = await namesFor(prisma, [...heavyViewers.map((v) => v.actorUserId), ...emergencies.map((e) => e.actorUserId)]);
    const alerts = [
      ...heavyViewers.map((v) => ({ key: `bulk-access:${v.actorUserId}`, severity: 'critical', category: 'Suspicious access', title: `${names.get(v.actorUserId)} opened ${v._count._all} patient records in the last hour`, detail: 'More than 20 patient profiles opened by one person in an hour. Check their stated reasons.', drill: { section: 'audit', filter: { actorUserId: v.actorUserId } } })),
      ...emergencies.filter((e) => !e.reviewedAt).map((e) => ({ key: `emergency:${e.id}`, severity: 'warning', category: 'Emergency access', title: `${names.get(e.actorUserId)} used emergency access`, detail: `Started ${e.startedAt.toISOString()}; awaiting review.`, drill: { section: 'audit', filter: { tab: 'emergency' } } })),
      ...failedSignIns.map((f) => ({ key: `sign-in:${f.actorUserId}`, severity: 'warning', category: 'Account security', title: `${f._count._all} failed sign-ins on one account in the last hour`, detail: 'Possible password guessing. The account is subject to the sign-in rate limits.', drill: { section: 'patients', filter: { id: f.actorUserId } } })),
      ...(failedNotifications > 10 ? [{ key: 'notifications', severity: 'warning', category: 'Notifications', title: `${failedNotifications} notifications failed in the last hour`, detail: 'Check the WhatsApp, push and email integrations.', drill: { section: 'jobs', filter: { type: 'notification', status: 'FAILED' } } }] : []),
      ...(badSignatures ? [{ key: 'webhook-signatures', severity: 'critical', category: 'Payments', title: `${badSignatures} payment webhook(s) with an invalid signature in 24 h`, detail: 'Someone may be forging payment confirmations, or the Paystack key changed. None of them were applied.', drill: { section: 'finance', filter: { tab: 'webhooks', outcome: 'REJECTED_SIGNATURE' } } }] : []),
      ...integrationList.filter((i) => ['NOT_CONFIGURED', 'DEGRADED'].includes(i.status)).map((i) => ({ key: `integration:${i.key}`, severity: i.status === 'DEGRADED' ? 'warning' : 'info', category: 'Integrations', title: `${i.name}: ${i.status === 'DEGRADED' ? 'degraded' : 'not configured'}`, detail: i.detail, drill: { section: 'integrations' } })),
      ...(licences ? [{ key: 'licences', severity: 'warning', category: 'Providers', title: `${licences} pharmacy licence(s) expire within 14 days`, detail: 'Remind the pharmacies to upload renewed licences.', drill: { section: 'providers', filter: { tab: 'expiring' } } }] : []),
    ];
    const order = { critical: 0, warning: 1, info: 2 };
    return { generatedAt: now.toISOString(), items: alerts.sort((a, b) => order[a.severity] - order[b.severity]) };
  }));
