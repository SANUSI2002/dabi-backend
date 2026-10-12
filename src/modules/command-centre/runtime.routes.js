import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { requireEmrPermission } from '../emr/core/context.js';
import { adminAudit, allow, ccError, handle, pageQuery, paged, reason } from './cc.common.js';
import * as billing from './subscriptions.service.js';

const none = z.object({}).strict(), uuid = z.uuid(), id = z.object({ id: uuid });
const read = (query = none, params = none) => validate(z.object({ query, params }));
const write = (body, params = none) => validate(z.object({ body, params, query: none }));
const text = (max) => z.string().trim().max(max).regex(/^[^\p{Cc}<>]*$/u);
const date = z.iso.date();
const version = z.number().int().min(1);
export const runtimeRoutes = express.Router();
runtimeRoutes.get('/settings', allow('platform.ops.read', 'platform.settings.manage'), read(), handle(() => prisma.platformRuntimeSettings.findUnique({ where: { id: 'default' } })));
runtimeRoutes.put('/settings', allow('platform.settings.manage'), requireRecentMfa, write(z.object({ expectedVersion: version, supportEmail: z.email().max(254), infoEmail: z.email().max(254), trackingRetentionDays: z.number().int().min(7).max(90), reason }).strict()), handle((q) => prisma.$transaction(async (tx) => {
  const before = await tx.platformRuntimeSettings.findUnique({ where: { id: 'default' } });
  const { expectedVersion, reason: why, ...data } = q.body;
  const changed = await tx.platformRuntimeSettings.updateMany({ where: { id: 'default', version: expectedVersion }, data: { ...data, updatedByUserId: q.user.id, version: { increment: 1 } } });
  if (!changed.count) throw ccError('VERSION_CONFLICT', 409, 'Settings changed. Refresh before saving.');
  await adminAudit(tx, q, { summary: 'Changed platform runtime settings', resourceType: 'platform-settings', resourceId: 'default', reason: why, before, after: data });
  return tx.platformRuntimeSettings.findUnique({ where: { id: 'default' } });
})));
runtimeRoutes.get('/presentation/:id', allow('platform.ops.read', 'platform.settings.manage'), read(none, id), handle(async (q) => {
  const organization = await prisma.identityOrganization.findUnique({ where: { id: q.params.id }, select: { organisation: { select: { name: true } }, pharmacy: { select: { name: true } } } });
  if (!organization) throw ccError('NOT_FOUND', 404, 'Organisation not found.');
  return await prisma.tenantPresentation.findUnique({ where: { organizationId: q.params.id } }) || { organizationId: q.params.id, version: 0, displayName: organization.organisation?.name || organization.pharmacy?.name || 'Sabi organisation', tagline: '', accentColor: '#065f46' };
}));
function accessibleAccent(color) {
  const linear = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const [r, g, b] = [1, 3, 5].map((n) => linear(parseInt(color.slice(n, n + 2), 16) / 255));
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05) >= 4.5;
}
runtimeRoutes.put('/presentation/:id', allow('platform.settings.manage'), requireRecentMfa, write(z.object({ expectedVersion: z.number().int().min(0), displayName: text(120).min(2), tagline: text(180), accentColor: z.string().regex(/^#[a-f\d]{6}$/i).refine(accessibleAccent, 'Choose a darker accent with readable white text.'), reason }).strict(), id), handle((q) => prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM identity_organizations WHERE id = ${q.params.id} FOR UPDATE`;
  if (!(await tx.identityOrganization.count({ where: { id: q.params.id } }))) throw ccError('NOT_FOUND', 404, 'Organisation not found.');
  const before = await tx.tenantPresentation.findUnique({ where: { organizationId: q.params.id } });
  if ((before?.version || 0) !== q.body.expectedVersion) throw ccError('VERSION_CONFLICT', 409, 'Branding changed. Refresh before saving.');
  const { reason: why, displayName, tagline, accentColor } = q.body;
  const data = { displayName, tagline, accentColor };
  const result = await tx.tenantPresentation.upsert({ where: { organizationId: q.params.id }, create: { organizationId: q.params.id, ...data, updatedByUserId: q.user.id }, update: { ...data, version: { increment: 1 }, updatedByUserId: q.user.id } });
  await adminAudit(tx, q, { summary: 'Changed organisation presentation', resourceType: 'tenant-presentation', resourceId: q.params.id, reason: why, before, after: data });
  return result;
})));
runtimeRoutes.get('/subscription-invoices', allow('platform.finance.read', 'platform.subscriptions.manage'), read(z.object({ ...pageQuery, organizationId: uuid.optional(), status: z.enum(['OPEN', 'PAID', 'VOID']).optional() }).strict()), handle(async (q) => {
  const { page, limit, organizationId, status } = q.query; const where = { ...(organizationId ? { organizationId } : {}), ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([prisma.subscriptionInvoice.findMany({ where, select: billing.invoiceSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }), prisma.subscriptionInvoice.count({ where })]);
  return paged(items, total, { page, limit });
}));
runtimeRoutes.post('/subscription-invoices', allow('platform.subscriptions.manage'), requireRecentMfa, write(z.object({ organizationId: uuid, requestKey: uuid, periodStart: date, dueAt: date, reason }).strict()), handle((q) => billing.createSubscriptionInvoice(q, q.body)));
runtimeRoutes.post('/subscription-invoices/:id/void', allow('platform.subscriptions.manage'), requireRecentMfa, write(z.object({ reason }).strict(), id), handle((q) => billing.voidSubscriptionInvoice(q, q.params.id, q.body.reason)));
runtimeRoutes.post('/subscription-invoices/:id/reconcile', allow('platform.finance.manage'), requireRecentMfa, write(z.object({ reason }).strict(), id), handle(async (q) => {
  const payment = await prisma.subscriptionPayment.findUnique({ where: { invoiceId: q.params.id } });
  if (!payment) throw ccError('NOT_FOUND', 404, 'No payment has been attempted for this invoice.');
  const result = await billing.reconcileSubscription(payment.reference);
  await adminAudit(prisma, q, { summary: 'Reconciled subscription payment', resourceType: 'subscription-invoice', resourceId: q.params.id, reason: q.body.reason });
  return result;
}));

// Tenant context, entitlement and account status have already been verified by EMR middleware.
export const tenantRuntimeRoutes = express.Router({ mergeParams: true });
const tenantParams = z.object({ organizationId: uuid });
const tenantId = tenantParams.extend({ id: uuid });
tenantRuntimeRoutes.get('/presentation', read(none, tenantParams), handle(async (q) => {
  const [presentation, settings] = await Promise.all([prisma.tenantPresentation.findUnique({ where: { organizationId: q.emr.organizationId }, select: { displayName: true, tagline: true, accentColor: true, version: true } }), prisma.platformRuntimeSettings.findUnique({ where: { id: 'default' }, select: { supportEmail: true, infoEmail: true } })]);
  return { presentation, contact: settings };
}));
tenantRuntimeRoutes.get('/subscription', requireEmrPermission('membership.manage', 'billing.read'), read(z.object(pageQuery).strict(), tenantParams), handle(async (q) => {
  const { page, limit } = q.query, where = { organizationId: q.emr.organizationId };
  const [items, total] = await Promise.all([prisma.subscriptionInvoice.findMany({ where, select: billing.invoiceSelect, orderBy: [{ periodStart: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }), prisma.subscriptionInvoice.count({ where })]);
  return paged(items, total, { page, limit });
}));
tenantRuntimeRoutes.post('/subscription/:id/pay', requireEmrPermission('membership.manage'), requireRecentMfa, write(none, tenantId), handle((q) => billing.startSubscriptionPayment(q.emr.organizationId, q.params.id)));
tenantRuntimeRoutes.post('/subscription/:id/check', requireEmrPermission('membership.manage', 'billing.read'), write(none, tenantId), handle(async (q) => {
  const payment = await prisma.subscriptionPayment.findFirst({ where: { invoiceId: q.params.id, invoice: { organizationId: q.emr.organizationId } } });
  if (!payment) throw ccError('NOT_FOUND', 404, 'No payment has been attempted for this invoice.');
  return billing.reconcileSubscription(payment.reference);
}));

export const publicRuntimeRoutes = express.Router();
publicRuntimeRoutes.get('/contact', handle(async (_q, res) => { res.set('Cache-Control', 'public, max-age=300'); return prisma.platformRuntimeSettings.findUnique({ where: { id: 'default' }, select: { supportEmail: true, infoEmail: true } }); }));
