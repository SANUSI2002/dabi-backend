// A patient's medicine schedules and today's doses.
import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { respond } from '../notifications/notification-settings.routes.js';
import * as S from './schedule.service.js';
import { CLOCK_TIME } from './schedule.time.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Not a date');
const times = z.array(z.string().regex(CLOCK_TIME, 'Times must be HH:MM')).max(8);
const idParams = z.object({ id: z.string().uuid() }).strict();

const createSchema = z.object({ body: z.object({
  prescriptionItemId: z.string().uuid().optional(),
  medicationId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  dosage: z.string().trim().max(64).nullable().optional(),
  instructions: z.string().trim().max(500).nullable().optional(),
  asNeeded: z.boolean().optional(),
  times: times.optional(),
  startDate: day.optional(),
  endDate: day.nullable().optional(),
  remindersEnabled: z.boolean().optional(),
}).strict() });
const updateSchema = z.object({ params: idParams, body: z.object({
  name: z.string().trim().min(1).max(120).optional(),
  dosage: z.string().trim().max(64).nullable().optional(),
  instructions: z.string().trim().max(500).nullable().optional(),
  times: times.optional(),
  endDate: day.nullable().optional(),
  remindersEnabled: z.boolean().optional(),
  paused: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Nothing to change') });
const dosesSchema = z.object({ query: z.object({ day: day.optional() }).strict() });

const router = express.Router();
router.use(protect);
router.get('/', respond((req) => S.listSchedules(req.user.id)));
router.get('/suggestions', respond((req) => S.suggestions(req.user.id)));
router.post('/', validate(createSchema), respond((req) => S.createSchedule(req.user.id, req.body)));
router.patch('/:id', validate(updateSchema), respond((req) => S.updateSchedule(req.user.id, req.params.id, req.body)));
router.post('/:id/stop', validate(z.object({ params: idParams })), respond((req) => S.stopSchedule(req.user.id, req.params.id)));
router.get('/doses', validate(dosesSchema), respond((req) => S.dosesForDay(req.user.id, req.query.day)));
router.post('/doses/:id/taken', validate(z.object({ params: idParams })), respond((req) => S.recordDose(req.user.id, req.params.id, 'TAKEN', { req })));
router.post('/doses/:id/skipped', validate(z.object({ params: idParams })), respond((req) => S.recordDose(req.user.id, req.params.id, 'SKIPPED', { req })));

export default router;
