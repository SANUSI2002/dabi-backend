// /api/v1/emr/organizations/:organizationId/webhooks — a tenant's own event subscriptions.
// The signing secret is shown once (on create / rotate) and stored only encrypted.
// Subscriptions are never hard-deleted; set active=false (delivery history stays auditable).
import express from 'express';
import { z } from 'zod';
import { withTenant } from '../core/db.js';
import { recordAudit, changedFieldNames } from '../core/audit.js';
import { etagFor, requireVersion, updateVersioned } from '../core/concurrency.js';
import { requireEmrPermission } from '../core/context.js';
import { EmrError } from '../core/errors.js';
import { encryptSecret, newWebhookSecret } from '../core/secrets.js';
import { validateWebhookUrl } from '../core/outbox.js';
import { handle, validateEmr } from '../core/validate.js';

export const EVENT_TYPES = [
  '*',
  'patient.registered', 'patient.updated', 'patient.deactivated', 'patient.reactivated', 'patient.account_linked',
  'encounter.created', 'encounter.started', 'encounter.finished', 'encounter.cancelled',
  'clinical_note.signed', 'clinical_note.amended', 'vitals.recorded', 'diagnosis.recorded',
  'lab.ordered', 'lab.order.cancelled', 'lab.result.released', 'lab.result.amended', 'lab.result.critical',
  'prescription.created', 'prescription.approved', 'prescription.rejected', 'prescription.cancelled',
  'medication.dispensed', 'medication.returned', 'allergy.recorded', 'stock.low',
  'admission.created', 'admission.transferred', 'admission.discharged', 'admission.cancelled', 'medication.administered',
];
const MAX_SUBSCRIPTIONS = 10;

const org = z.object({ organizationId: z.uuid() }).strict();
const one = z.object({ organizationId: z.uuid(), subscriptionId: z.uuid() }).strict();
const url = z.string().trim().max(2048).superRefine((value, ctx) => {
  const problem = validateWebhookUrl(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
const eventTypes = z.array(z.enum(EVENT_TYPES)).min(1).max(EVENT_TYPES.length).transform((types) => [...new Set(types)]);

const select = { id: true, url: true, eventTypes: true, active: true, version: true, createdAt: true, updatedAt: true };
const router = express.Router({ mergeParams: true });
router.use(requireEmrPermission('emr.webhook.manage'));

router.get('/', validateEmr(z.object({ params: org, query: z.object({}).strict() })), handle(async (req, res) => {
  const items = await withTenant(req.emr, (tx) => tx.emrWebhookSubscription.findMany({ where: { organizationId: req.emr.organizationId }, select, orderBy: { createdAt: 'desc' } }));
  res.json({ status: 'success', data: { items, eventTypes: EVENT_TYPES } });
}));

router.post('/', validateEmr(z.object({ params: org, query: z.object({}).strict(), body: z.object({ url, eventTypes }).strict() })), handle(async (req, res) => {
  const secret = newWebhookSecret();
  const subscription = await withTenant(req.emr, async (tx) => {
    const count = await tx.emrWebhookSubscription.count({ where: { organizationId: req.emr.organizationId, active: true } });
    if (count >= MAX_SUBSCRIPTIONS) throw new EmrError('INVALID_STATE', { message: `An organization can have at most ${MAX_SUBSCRIPTIONS} active webhooks.` });
    const row = await tx.emrWebhookSubscription.create({
      data: { organizationId: req.emr.organizationId, url: req.body.url, eventTypes: req.body.eventTypes, secretCiphertext: encryptSecret(secret), createdByUserId: req.emr.userId },
      select,
    });
    await recordAudit(tx, req.emr, { action: 'webhook.created', resourceType: 'webhook_subscription', resourceId: row.id });
    return row;
  });
  res.status(201).set('ETag', etagFor(subscription.version)).json({ status: 'success', data: { ...subscription, secret } });
}));

router.patch('/:subscriptionId', validateEmr(z.object({
  params: one, query: z.object({}).strict(),
  body: z.object({ url: url.optional(), eventTypes: eventTypes.optional(), active: z.boolean().optional() }).strict()
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
})), handle(async (req, res) => {
  const expectedVersion = requireVersion(req);
  const subscription = await withTenant(req.emr, async (tx) => {
    const current = await tx.emrWebhookSubscription.findFirst({ where: { organizationId: req.emr.organizationId, id: req.params.subscriptionId }, select });
    if (!current) throw new EmrError('SUBSCRIPTION_NOT_FOUND');
    const row = await updateVersioned(tx.emrWebhookSubscription, { organizationId: req.emr.organizationId, id: current.id, expectedVersion, data: req.body, select, notFoundCode: 'SUBSCRIPTION_NOT_FOUND' });
    await recordAudit(tx, req.emr, { action: 'webhook.updated', resourceType: 'webhook_subscription', resourceId: row.id, changedFields: changedFieldNames(current, req.body) });
    return row;
  });
  res.set('ETag', etagFor(subscription.version)).json({ status: 'success', data: subscription });
}));

router.post('/:subscriptionId/rotate-secret', validateEmr(z.object({ params: one, query: z.object({}).strict(), body: z.object({}).strict() })), handle(async (req, res) => {
  const expectedVersion = requireVersion(req);
  const secret = newWebhookSecret();
  const subscription = await withTenant(req.emr, async (tx) => {
    const row = await updateVersioned(tx.emrWebhookSubscription, { organizationId: req.emr.organizationId, id: req.params.subscriptionId, expectedVersion, data: { secretCiphertext: encryptSecret(secret) }, select, notFoundCode: 'SUBSCRIPTION_NOT_FOUND' });
    await recordAudit(tx, req.emr, { action: 'webhook.secret_rotated', resourceType: 'webhook_subscription', resourceId: row.id });
    return row;
  });
  res.set('ETag', etagFor(subscription.version)).json({ status: 'success', data: { ...subscription, secret } });
}));

router.get('/:subscriptionId/deliveries', validateEmr(z.object({ params: one, query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict() })), handle(async (req, res) => {
  const items = await withTenant(req.emr, async (tx) => {
    const exists = await tx.emrWebhookSubscription.findFirst({ where: { organizationId: req.emr.organizationId, id: req.params.subscriptionId }, select: { id: true } });
    if (!exists) throw new EmrError('SUBSCRIPTION_NOT_FOUND');
    return tx.emrWebhookDelivery.findMany({
      where: { organizationId: req.emr.organizationId, subscriptionId: exists.id },
      select: { id: true, eventId: true, status: true, attempts: true, nextAttemptAt: true, lastStatusCode: true, lastError: true, deliveredAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: req.query.limit,
    });
  });
  res.json({ status: 'success', data: { items } });
}));

export default router;
