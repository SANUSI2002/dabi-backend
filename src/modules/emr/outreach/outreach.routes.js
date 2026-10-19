// /api/v1/emr/organizations/:organizationId/outreach (community outreach activity log)
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
// The CHW roster is GET /staff?permission=outreach.chw.
//
// Who can do what (migration 20261104090000_emr_outreach):
//   community health worker, nurse: see and log activities; mark a mistaken entry entered in error
//   doctor, hospital admin:         see
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as outreach from './outreach.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const v = {
  list: z.object({
    params: z.object(org).strict(),
    query: z.object({ includeEnteredInError: z.enum(['true', 'false']).transform((s) => s === 'true').optional(), limit: z.coerce.number().int().min(1).max(1000).default(500) }).strict(),
  }),
  log: z.object({
    params: z.object(org).strict(),
    query: noQuery,
    body: z.object({
      chwUserId: z.string().min(1).max(64), activityType: z.enum(outreach.OUTREACH_TYPES), ward: text(120),
      households: z.number().int().min(0).max(100000), referrals: z.number().int().min(0).max(100000), activityDate: z.iso.date(), notes: text(2000).optional(),
    }).strict(),
  }),
  inError: z.object({ params: z.object({ ...org, activityId: z.uuid() }).strict(), query: noQuery, body: z.object({ reason: text(500) }).strict() }),
};

export const outreachRoutes = express.Router({ mergeParams: true });
outreachRoutes.get('/', check(v.list), allow('outreach.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await outreach.listActivities(req.emr, req.query) })));
outreachRoutes.post('/', check(v.log), allow('outreach.record'),
  handle(async (req, res) => sendResult(res, await outreach.logActivity(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
outreachRoutes.post('/:activityId/entered-in-error', check(v.inError), allow('outreach.record'),
  handle(async (req, res) => send(res, await outreach.markActivityInError(req.emr, req.params.activityId, req.body))));
