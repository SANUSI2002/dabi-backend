import { Router } from 'express';
import { z } from 'zod';
import { requireEmrPermission } from '../../emr/core/context.js';
import { handle, validateEmr } from '../../emr/core/validate.js';
import { listJevAssessments, queueJevAssessment, reviewJevAssessment } from './jev.assessments.js';
const routes = Router({ mergeParams: true });
const empty = z.object({}).strict();
const source = z.object({ encounterId: z.uuid(), noteId: z.uuid() });
routes.use(requireEmrPermission('clinical.note.sign'));
routes.get('/encounters/:encounterId/notes/:noteId/assessments', validateEmr(z.object({ params: source, query: empty })), handle(async (req, res) => res.json({ status: 'success', data: await listJevAssessments(req.emr, req.params.encounterId, req.params.noteId) })));
routes.post('/encounters/:encounterId/notes/:noteId/assessments', validateEmr(z.object({ params: source, query: empty, body: z.object({ clientRequestId: z.uuid(), noteVersion: z.number().int().min(1) }).strict() })),
  handle(async (req, res) => res.status(202).json({ status: 'success', data: await queueJevAssessment(req.emr, req.params.encounterId, req.params.noteId, req.body) })));
routes.post('/assessments/:assessmentId/reviews', validateEmr(z.object({ params: z.object({ assessmentId: z.uuid() }), query: empty, body: z.object({ clientRequestId: z.uuid(), disposition: z.enum(['ACCEPTED','REJECTED','DEFERRED']), reason: z.string().trim().min(3).max(2000) }).strict() })),
  handle(async (req, res) => res.status(201).json({ status: 'success', data: await reviewJevAssessment(req.emr, req.params.assessmentId, req.body) })));
export default routes;
