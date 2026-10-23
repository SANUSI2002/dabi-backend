// /api/v1/emr/organizations/:organizationId/family-planning
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261030090000_emr_family_planning):
//   doctor, nurse:  see, register, record visits, discontinue
//   hospital admin: see
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as fp from './family-planning.service.js';

const org = { organizationId: z.uuid() };
const one = { ...org, clientId: z.uuid() };
const noQuery = z.object({}).strict();
const prose = z.string().trim().min(1).max(1000).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const v = {
  list: z.object({
    params: z.object(org).strict(),
    query: z.object({
      status: z.string().transform((s) => s.split(',')).pipe(z.array(z.enum(['ACTIVE', 'DISCONTINUED'])).min(1)).optional(),
      patientId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).strict(),
  }),
  register: z.object({
    params: z.object(org).strict(),
    query: noQuery,
    body: z.object({
      patientId: z.uuid(), method: z.enum(fp.FP_METHODS), firstTime: z.boolean().default(false), startDate: z.iso.date(),
      nextVisitDate: z.iso.date().optional(), counselled: z.boolean().default(true), notes: prose.optional(),
    }).strict(),
  }),
  visit: z.object({
    params: z.object(one).strict(),
    query: noQuery,
    body: z.object({
      visitType: z.enum(['REVISIT', 'RESUPPLY', 'SWITCH_METHOD', 'REMOVAL']), method: z.enum(fp.FP_METHODS).optional(),
      visitDate: z.iso.date().optional(), nextVisitDate: z.iso.date().optional(), notes: prose.optional(),
    }).strict().refine((b) => b.visitType !== 'SWITCH_METHOD' || !!b.method, { path: ['method'], message: 'Choose the new method.' }),
  }),
  discontinue: z.object({ params: z.object(one).strict(), query: noQuery, body: z.object({ reason: z.string().trim().min(1).max(120) }).strict() }), // a reasons-for-stopping item
};

export const familyPlanningRoutes = express.Router({ mergeParams: true });
familyPlanningRoutes.get('/', check(v.list), allow('fp.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await fp.listClients(req.emr, req.query) })));
familyPlanningRoutes.post('/', check(v.register), allow('fp.manage'),
  handle(async (req, res) => sendResult(res, await fp.registerClient(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
familyPlanningRoutes.post('/:clientId/visits', check(v.visit), allow('fp.manage'),
  handle(async (req, res) => send(res, await fp.recordVisit(req.emr, req.params.clientId, requireVersion(req), req.body), 201)));
familyPlanningRoutes.post('/:clientId/discontinue', check(v.discontinue), allow('fp.manage'),
  handle(async (req, res) => send(res, await fp.discontinue(req.emr, req.params.clientId, requireVersion(req), req.body))));
