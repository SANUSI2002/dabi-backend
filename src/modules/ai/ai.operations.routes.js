import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { adminAudit, allow, ccError, handle, reason } from '../command-centre/cc.common.js';
import { aiAvailable, aiConfig, aiLimits } from './ai.config.js';
import { aiRuntimeConfiguration } from './ai.readiness.js';

export const aiOperationsRoutes = Router();
const empty = z.object({}).strict();
const write = (body, params = empty) => validate(z.object({ body, params, query: empty }));
aiOperationsRoutes.get('/overview', allow('platform.ops.read', 'platform.settings.manage'), validate(z.object({ query: empty, params: empty })), handle(async () => {
  const [policy, counts, flagged, oldest] = await Promise.all([
    prisma.aiRuntimePolicy.findUnique({ where: { id: 'global' } }),
    prisma.aiRun.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.aiRun.count({ where: { feedback: 'UNSAFE' } }),
    prisma.aiRun.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  if (!policy) throw ccError('AI_CONTROLS_UNAVAILABLE', 503, 'AI operational controls are unavailable. Generation remains disabled.');
  const config = aiConfig();
  return { generatedAt: new Date(), policy, providerConfigured: aiAvailable(), provider: config.provider, model: config.model || null,
    generationEnabled: aiAvailable() && policy?.generationPaused === false, counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
    flagged, oldestQueuedAt: oldest?.createdAt || null, limits: aiLimits(), monetaryBillingEnabled: false,
    runtime: aiRuntimeConfiguration(),
  };
}));
aiOperationsRoutes.post('/policy', allow('platform.settings.manage'), requireRecentMfa,
  write(z.object({ expectedVersion: z.number().int().min(1), generationPaused: z.boolean(), reason }).strict()),
  handle((req) => prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(739294, 1)::text`;
    const before = await tx.aiRuntimePolicy.findUnique({ where: { id: 'global' } });
    const changed = await tx.aiRuntimePolicy.updateMany({ where: { id: 'global', version: req.body.expectedVersion }, data: { generationPaused: req.body.generationPaused, updatedByUserId: req.user.id, version: { increment: 1 } } });
    if (!changed.count) throw ccError('VERSION_CONFLICT', 409, 'AI controls changed. Refresh before saving.');
    await adminAudit(tx, req, { summary: req.body.generationPaused ? 'Paused new Sabi AI generation' : 'Resumed configured Sabi AI generation', resourceType: 'ai-runtime-policy', resourceId: 'global', reason: req.body.reason, before: { version: before.version, generationPaused: before.generationPaused }, after: { generationPaused: req.body.generationPaused } });
    return tx.aiRuntimePolicy.findUnique({ where: { id: 'global' } });
  })));
aiOperationsRoutes.get('/runs', allow('platform.ops.read', 'platform.audit.read'),
  validate(z.object({ params: empty, query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(10000).default(0), status: z.enum(['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED']).optional(), flagged: z.enum(['true']).optional() }).strict() })),
  handle(async (req) => {
    const where = { ...(req.query.status ? { status: req.query.status } : {}), ...(req.query.flagged ? { feedback: 'UNSAFE' } : {}) };
    const [items, total] = await Promise.all([
      prisma.aiRun.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: req.query.offset, take: req.query.limit,
        select: { id: true, status: true, model: true, promptVersion: true, createdAt: true, startedAt: true, finishedAt: true, errorCode: true, feedback: true, feedbackAt: true } }),
      prisma.aiRun.count({ where }),
    ]);
    return { items, total, limit: req.query.limit, offset: req.query.offset };
  }));
aiOperationsRoutes.post('/traces/:id/read', allow('platform.audit.read'), requireRecentMfa,
  write(z.object({ reason }).strict(), z.object({ id: z.uuid() }).strict()),
  handle((req) => prisma.$transaction(async (tx) => {
    const run = await tx.aiRun.findUnique({ where: { id: req.params.id }, select: { id: true, sessionId: true, status: true, model: true, promptVersion: true, errorCode: true, feedback: true, usage: true, createdAt: true, startedAt: true, finishedAt: true, session: { select: { ownerUserId: true, mode: true, archivedAt: true } } } });
    if (!run) throw ccError('NOT_FOUND', 404, 'AI trace not found.');
    await adminAudit(tx, req, { summary: 'Inspected Sabi AI trace metadata', resourceType: 'ai-run', resourceId: run.id, subjectUserId: run.session.ownerUserId, reason: req.body.reason });
    // No message, personal-memory content, auth-session identifier or hidden reasoning is returned.
    return { ...run, usage: run.usage ? { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, memoryCount: run.usage.memoryCount, memoryVersion: run.usage.memoryVersion } : null };
  })));
