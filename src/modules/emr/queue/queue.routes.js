// Station queue: /api/v1/emr/organizations/:organizationId/queue/...
// Check-in (joining the queue) is POST /encounters with { patientId, station, priority, reason }.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendItems } from '../core/http.js';
import * as queue from './queue.service.js';
import { QUEUE_PRIORITIES, QUEUE_STATIONS, QUEUE_STATUSES } from './queue.constants.js';

const org = { organizationId: z.uuid() };
const station = z.enum(QUEUE_STATIONS);
const priority = z.enum(QUEUE_PRIORITIES);
const status = z.enum(QUEUE_STATUSES);
const entryParams = z.object({ ...org, entryId: z.uuid() }).strict();

const list = z.object({
  params: z.object(org).strict(),
  query: z.object({
    station: station.optional(),
    status: z.string().optional().transform((value) => (value ? value.split(',') : undefined)).pipe(z.array(status).max(4).optional()),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }).strict(),
});
const callNext = z.object({ params: z.object(org).strict(), query: z.object({}).strict(), body: z.object({ station }).strict() });
const update = z.object({
  params: entryParams, query: z.object({}).strict(),
  body: z.object({ station: station.optional(), status: status.optional(), priority: priority.optional() })
    .strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});
const one = z.object({ params: entryParams, query: z.object({}).strict() });

export const queueRoutes = express.Router({ mergeParams: true });
queueRoutes.get('/', check(list), allow('queue.read'), handle(async (req, res) => sendItems(res, await queue.listQueue(req.emr, req.query))));
queueRoutes.post('/call-next', check(callNext), allow('queue.manage'), handle(async (req, res) => send(res, await queue.callNext(req.emr, req.body))));
queueRoutes.patch('/:entryId', check(update), allow('queue.manage'),
  handle(async (req, res) => send(res, await queue.updateEntry(req.emr, req.params.entryId, requireVersion(req), req.body))));
queueRoutes.get('/:entryId/history', check(one), allow('queue.read'), handle(async (req, res) => sendItems(res, await queue.history(req.emr, req.params.entryId))));
