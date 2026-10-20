import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { adminAudit, allow, ccError, handle, reason } from '../command-centre/cc.common.js';
import { allowanceSettingsSchema, allowancePolicy, allowanceLock, allowanceBoundaries, allowanceSnapshot, publicAllowance, finishAllowance } from './ai.allowances.js';

export const allowanceRoutes = Router();
const empty = z.object({}).strict();
const userParams = z.object({ id: z.uuid() }).strict();
const write = (body, params = empty) => validate(z.object({ body, params, query: empty }));
const numeric = z.number().int().min(0).max(10000000);

allowanceRoutes.get('/', allow('platform.ops.read', 'platform.settings.manage'), handle(async () => {
  const policy = await allowancePolicy();
  return { ...policy, nextWindows: await allowanceBoundaries(prisma, policy.settings), unit: 'PROVIDER_TOKENS', currencyBillingEnabled: false };
}));
allowanceRoutes.post('/policy', allow('platform.settings.manage'), requireRecentMfa,
  write(z.object({ expectedVersion: z.number().int().positive(), settings: allowanceSettingsSchema, reason }).strict()),
  handle((req) => prisma.$transaction(async (tx) => {
    await allowanceLock(tx); const before = await allowancePolicy(tx);
    const changed = await tx.aiAllowancePolicy.updateMany({ where: { id: 'global', version: req.body.expectedVersion }, data: { settings: req.body.settings, version: { increment: 1 } } });
    if (!changed.count) throw ccError('VERSION_CONFLICT', 409, 'AI allocation settings changed. Refresh before saving.');
    await adminAudit(tx, req, { summary: 'Updated Sabi AI token and request allocation policy', resourceType: 'ai-allowance-policy', resourceId: 'global', reason: req.body.reason, before: before.settings, after: req.body.settings });
    return allowancePolicy(tx);
  })));
allowanceRoutes.get('/users', allow('platform.settings.manage'),
  validate(z.object({ params: empty, query: z.object({ q: z.string().trim().max(200).default(''), limit: z.coerce.number().int().min(1).max(25).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict() })),
  handle(async (req) => {
    const where = req.query.q ? { OR: [{ email: { contains: req.query.q, mode: 'insensitive' } }, { full_name: { contains: req.query.q, mode: 'insensitive' } }, ...(z.uuid().safeParse(req.query.q).success ? [{ id: req.query.q }] : [])] } : {};
    const users = await prisma.user.findMany({ where, skip: req.query.offset, take: req.query.limit, orderBy: { id: 'asc' }, select: { id: true, email: true, full_name: true, accountStatus: true } });
    // Fixed-size pages only; do not open every user's allocation while listing the entire registry.
    const items = [];
    for (const user of users) items.push({ ...user, allowance: await prisma.$transaction(async (tx) => { await allowanceLock(tx); return publicAllowance(await allowanceSnapshot(tx, user.id)); }) });
    return { items, total: await prisma.user.count({ where }), limit: req.query.limit, offset: req.query.offset };
  }));
allowanceRoutes.get('/users/:id', allow('platform.settings.manage'), validate(z.object({ params: userParams, query: empty })),
  handle((req) => prisma.$transaction(async (tx) => {
    await allowanceLock(tx);
    const snapshot = publicAllowance(await allowanceSnapshot(tx, req.params.id));
    const [ledger, reservations] = await Promise.all([
      tx.aiAllowanceLedger.findMany({ where: { userId: req.params.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 }),
      tx.aiAllowanceReservation.findMany({ where: { userId: req.params.id, state: 'UNCERTAIN' }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return { ...snapshot, ledger, uncertainReservations: reservations };
  })));
allowanceRoutes.post('/users/:id/override', allow('platform.settings.manage'), requireRecentMfa,
  write(z.object({ expectedVersion: z.number().int().positive(), dailyRequests: z.number().int().min(0).max(10000).nullable(), tokenAllowance: numeric.nullable(), reason }).strict(), userParams),
  handle((req) => prisma.$transaction(async (tx) => {
    await allowanceLock(tx); const before = await allowanceSnapshot(tx, req.params.id);
    const changed = await tx.aiAllowanceAccount.updateMany({ where: { userId: req.params.id, version: req.body.expectedVersion }, data: { dailyRequestOverride: req.body.dailyRequests, tokenAllowanceOverride: req.body.tokenAllowance, version: { increment: 1 } } });
    if (!changed.count) throw ccError('VERSION_CONFLICT', 409, 'This allocation changed. Refresh before saving.');
    await adminAudit(tx, req, { summary: 'Changed an individual Sabi AI allocation', subjectUserId: req.params.id, resourceType: 'ai-allowance-account', resourceId: req.params.id, reason: req.body.reason, before: before.overrides, after: { dailyRequests: req.body.dailyRequests, tokenAllowance: req.body.tokenAllowance } });
    return publicAllowance(await allowanceSnapshot(tx, req.params.id));
  })));
allowanceRoutes.post('/users/:id/adjust', allow('platform.settings.manage'), requireRecentMfa,
  write(z.object({ clientRequestId: z.uuid(), expectedVersion: z.number().int().positive(), deltaTokens: z.number().int().min(-1000000).max(1000000).refine((n) => n !== 0), reason }).strict(), userParams),
  handle((req) => prisma.$transaction(async (tx) => {
    await allowanceLock(tx);
    const eventKey = `adjust:${req.body.clientRequestId}`;
    const existing = await tx.aiAllowanceLedger.findUnique({ where: { eventKey } });
    if (existing) {
      if (existing.userId !== req.params.id || existing.bonusDelta !== req.body.deltaTokens) throw ccError('IDEMPOTENCY_CONFLICT', 409, 'This adjustment reference was already used.');
      return publicAllowance(await allowanceSnapshot(tx, req.params.id));
    }
    const before = await allowanceSnapshot(tx, req.params.id);
    if (req.body.deltaTokens < -before.tokens.remaining) throw ccError('AI_ADJUSTMENT_INVALID', 422, 'A reduction cannot remove tokens already used or reserved.');
    if (Math.abs(before.tokens.bonus + req.body.deltaTokens) > 10000000) throw ccError('AI_ADJUSTMENT_INVALID', 422, 'Period adjustments cannot exceed ten million tokens.');
    const changed = await tx.aiAllowanceAccount.updateMany({ where: { userId: req.params.id, version: req.body.expectedVersion }, data: { version: { increment: 1 } } });
    if (!changed.count) throw ccError('VERSION_CONFLICT', 409, 'This allocation changed. Refresh before adjusting.');
    await tx.aiAllowanceWindow.update({ where: { id: before.tokenWindowId }, data: { bonusUnits: { increment: req.body.deltaTokens } } });
    await tx.aiAllowanceLedger.create({ data: { userId: req.params.id, windowId: before.tokenWindowId, eventKey, type: 'ADMIN_ADJUSTMENT', bonusDelta: req.body.deltaTokens, metadata: { actorUserId: req.user.id, reason: req.body.reason } } });
    await adminAudit(tx, req, { summary: 'Adjusted current-period Sabi AI tokens', subjectUserId: req.params.id, resourceType: 'ai-allowance-account', resourceId: req.params.id, reason: req.body.reason, before: { bonus: before.tokens.bonus }, after: { deltaTokens: req.body.deltaTokens } });
    return publicAllowance(await allowanceSnapshot(tx, req.params.id));
  })));
allowanceRoutes.post('/reservations/:id/reconcile', allow('platform.settings.manage'), requireRecentMfa,
  write(z.object({ usage: z.object({ inputTokens: numeric, outputTokens: numeric, totalTokens: numeric }).strict().refine((u) => u.totalTokens >= u.inputTokens + u.outputTokens), proofReference: z.string().trim().min(5).max(200), reason }).strict(), userParams),
  handle((req) => prisma.$transaction(async (tx) => {
    await allowanceLock(tx);
    const row = await tx.aiAllowanceReservation.findUnique({ where: { id: req.params.id } });
    if (!row || row.state !== 'UNCERTAIN') throw ccError('INVALID_STATE', 409, 'Only unresolved provider outcomes can be reconciled. Refresh this account.');
    await finishAllowance(tx, row.resourceKind, row.resourceId, { usage: req.body.usage });
    await adminAudit(tx, req, { summary: 'Reconciled an uncertain AI provider token outcome', subjectUserId: row.userId, resourceType: 'ai-allowance-reservation', resourceId: row.id, reason: req.body.reason, after: { ...req.body.usage, proofReference: req.body.proofReference } });
    return { reconciled: true };
  })));
