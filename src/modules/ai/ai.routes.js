import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { AI_CONSENT_VERSION, AI_DOCUMENT_CONSENT_VERSION, aiDocumentsAvailable, aiError } from './ai.config.js';
import { generationAvailable } from './ai.policy.js';
import * as service from './ai.service.js';
import * as memory from './ai.memory.js';
import * as sources from './ai.sources.js';
import * as actions from './ai.actions.js';
const routes = Router();
routes.use(protect, (req, res, next) => { req.aiRequestId = randomUUID(); res.set('Cache-Control', 'no-store'); next(); });
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 503;
    res.status(status).json({ status: 'error', requestId: req.aiRequestId,
      error: { code: error.code?.startsWith('AI_') ? error.code : 'AI_UNAVAILABLE', message: error.status ? error.message : 'Sabi AI is temporarily unavailable.', retryable: status === 503 } });
  }
};
const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) throw aiError(422, 'AI_INVALID_REQUEST', 'Check the supplied fields and try again.'); return result.data; };
const id = z.string().uuid();
const send = (req, res, data, status = 200) => res.status(status).json({ status: 'success', requestId: req.aiRequestId, data });
const limiter = createLimiter({ kind: 'ai-messages', max: 30, keyGenerator: (req) => `ai:${req.user.id}` });
routes.get('/config', handle(async (req, res) => {
  const enabled = await generationAvailable();
  send(req, res, { enabled, consentVersion: AI_CONSENT_VERSION, documentConsentVersion: AI_DOCUMENT_CONSENT_VERSION, documents: enabled && aiDocumentsAvailable(), actions: ['REMINDER_TOGGLE'], modes: ['GENERAL'], personalRecords: false, tools: false, billing: false });
}));
routes.get('/action-targets/reminders', handle(async (req, res) => send(req, res, { items: await actions.reminderActionTargets(req.user.id) })));
routes.get('/sessions/:id/actions', handle(async (req, res) => send(req, res, { items: await actions.listAiActions(req.user.id, parse(id, req.params.id)) })));
routes.post('/sessions/:id/actions/reminders', limiter, handle(async (req, res) => {
  const input = parse(z.object({ clientRequestId: id, scheduleId: id, expectedVersion: z.number().int().min(1), enableReminders: z.boolean() }).strict(), req.body);
  send(req, res, await actions.proposeReminderAction(req.user.id, parse(id, req.params.id), input), 201);
}));
routes.post('/actions/:id/confirm', limiter, handle(async (req, res) => {
  parse(z.object({ confirm: z.literal(true) }).strict(), req.body);
  send(req, res, await actions.confirmAiAction(req.user.id, parse(id, req.params.id)));
}));
routes.post('/actions/:id/cancel', limiter, handle(async (req, res) => {
  parse(z.object({}).strict(), req.body);
  send(req, res, await actions.cancelAiAction(req.user.id, parse(id, req.params.id)));
}));
routes.get('/source-documents', handle(async (req, res) => send(req, res, { items: await sources.listAiSourceDocuments(req.user.id) })));
routes.get('/sources', handle(async (req, res) => send(req, res, { items: await sources.listAiSources(req.user.id) })));
routes.post('/sources', limiter, handle(async (req, res) => {
  const input = parse(z.object({ documentId: id, clientRequestId: id, consentGiven: z.literal(true), consentVersion: z.literal(AI_DOCUMENT_CONSENT_VERSION) }).strict(), req.body);
  send(req, res, await sources.createAiSource(req.user, input), 202);
}));
routes.get('/sources/:id', handle(async (req, res) => send(req, res, await sources.getAiSource(req.user.id, parse(id, req.params.id)))));
routes.post('/sources/:id/review', limiter, handle(async (req, res) => {
  const input = parse(z.object({ revision: z.number().int().min(1), patientMatchConfirmed: z.literal(true), extractionReviewed: z.literal(true), pages: z.array(z.object({ pageNumber: z.number().int().min(1).max(20), text: z.string().max(12000) }).strict()).min(1).max(20) }).strict(), req.body);
  send(req, res, await sources.reviewAiSource(req.user.id, parse(id, req.params.id), input));
}));
routes.post('/sources/:id/preview', handle(async (req, res) => {
  const input = parse(z.object({ pageNumber: z.number().int().min(1).max(20) }).strict(), req.body);
  send(req, res, await sources.previewAiSource(req.user.id, parse(id, req.params.id), input.pageNumber));
}));
routes.delete('/sources/:id', handle(async (req, res) => {
  parse(z.object({ confirm: z.literal(true) }).strict(), req.body);
  send(req, res, await sources.deleteAiSource(req.user.id, parse(id, req.params.id)));
}));
routes.get('/sessions', handle(async (req, res) => send(req, res, { items: await service.listAiSessions(req.user.id) })));
routes.get('/usage', handle(async (req, res) => send(req, res, await service.getAiUsage(req.user.id))));
routes.get('/memory', handle(async (req, res) => send(req, res, { items: await memory.listAiMemory(req.user.id) })));
const memoryInput = z.object({ kind: z.enum(['PREFERENCE', 'USER_REPORTED']), content: z.string().trim().min(1).max(1000), sourceSessionId: id.optional() });
routes.post('/memory', limiter, handle(async (req, res) => send(req, res, await memory.saveAiMemory(req.user.id, parse(memoryInput.strict(), req.body)), 201)));
routes.patch('/memory/:id', limiter, handle(async (req, res) => send(req, res, await memory.saveAiMemory(req.user.id, parse(memoryInput.omit({ sourceSessionId: true }).extend({ revision: z.number().int().min(1) }).strict(), req.body), parse(id, req.params.id)))));
routes.delete('/memory/:id', handle(async (req, res) => send(req, res, await memory.deleteAiMemory(req.user.id, parse(id, req.params.id)))));
routes.post('/runs/:id/feedback', handle(async (req, res) => {
  const input = parse(z.object({ feedback: z.enum(['HELPFUL', 'UNCLEAR', 'UNSAFE']) }).strict(), req.body);
  send(req, res, await service.rateAiRun(req.user.id, parse(id, req.params.id), input.feedback));
}));
routes.post('/sessions', limiter, handle(async (req, res) => {
  const input = parse(z.object({ title: z.string().trim().min(1).max(120).optional(), consentGiven: z.literal(true), consentVersion: z.literal(AI_CONSENT_VERSION), mode: z.literal('GENERAL').default('GENERAL') }).strict(), req.body);
  send(req, res, await service.createAiSession(req.user.id, input), 201);
}));
routes.get('/sessions/:id', handle(async (req, res) => send(req, res, await service.getAiSession(req.user.id, parse(id, req.params.id)))));
routes.patch('/sessions/:id', limiter, handle(async (req, res) => {
  const input = parse(z.object({ title: z.string().trim().min(1).max(120) }).strict(), req.body);
  send(req, res, await service.renameAiSession(req.user.id, parse(id, req.params.id), input.title));
}));
routes.delete('/sessions/:id', handle(async (req, res) => {
  parse(z.object({ confirm: z.literal(true) }).strict(), req.body);
  send(req, res, await service.deleteAiSession(req.user.id, parse(id, req.params.id)));
}));
routes.get('/sessions/:id/export', handle(async (req, res) => send(req, res, await service.exportAiSession(req.user.id, parse(id, req.params.id)))));
routes.post('/sessions/:id/messages', limiter, handle(async (req, res) => {
  const input = parse(z.object({ clientMessageId: z.string().uuid(), message: z.string().trim().min(1).max(4000), sourceIds: z.array(id).max(3).optional() }).strict(), req.body);
  const run = await service.queueAiMessage(req.user, parse(id, req.params.id), input);
  send(req, res, run, ['QUEUED', 'RUNNING'].includes(run.status) ? 202 : 200);
}));
routes.get('/runs/:id', handle(async (req, res) => send(req, res, await service.getAiRun(req.user.id, parse(id, req.params.id)))));
routes.post('/runs/:id/cancel', handle(async (req, res) => send(req, res, await service.cancelAiRun(req.user.id, parse(id, req.params.id)))));
export default routes;
