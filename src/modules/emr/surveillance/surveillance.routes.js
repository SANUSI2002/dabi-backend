// /api/v1/emr/organizations/:organizationId/surveillance
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261029090000_emr_surveillance):
//   doctor:              see, notify, confirm or discard
//   nurse:               see, notify
//   lab scientist, admin: see
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as surveillance from './surveillance.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const note = z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const v = {
  list: z.object({
    params: z.object(org).strict(),
    query: z.object({
      status: z.string().transform((s) => s.split(',')).pipe(z.array(z.enum(['SUSPECTED', 'CONFIRMED', 'DISCARDED'])).min(1)).optional(),
      since: z.iso.date().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).strict(),
  }),
  notify: z.object({
    params: z.object(org).strict(),
    query: noQuery,
    body: z.object({
      patientId: z.uuid(),
      diseaseCode: z.enum(surveillance.DISEASE_CODES),
      onsetDate: z.iso.date().optional(),
      notes: z.string().trim().min(1).max(1000).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters').optional(),
    }).strict(),
  }),
  classify: z.object({
    params: z.object({ ...org, caseId: z.uuid() }).strict(),
    query: noQuery,
    body: z.object({ status: z.enum(['CONFIRMED', 'DISCARDED']), note: note.optional() }).strict()
      .refine((b) => b.status === 'CONFIRMED' || !!b.note, { path: ['note'], message: 'Say why the case is discarded.' }),
  }),
};

export const surveillanceRoutes = express.Router({ mergeParams: true });
surveillanceRoutes.get('/', check(v.list), allow('surveillance.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await surveillance.listCases(req.emr, req.query) })));
surveillanceRoutes.post('/', check(v.notify), allow('surveillance.notify'),
  handle(async (req, res) => sendResult(res, await surveillance.notifyCase(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
surveillanceRoutes.post('/:caseId/classify', check(v.classify), allow('surveillance.classify'),
  handle(async (req, res) => send(res, await surveillance.classifyCase(req.emr, req.params.caseId, requireVersion(req), req.body))));
