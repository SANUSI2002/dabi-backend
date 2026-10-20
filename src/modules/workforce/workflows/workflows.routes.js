// /api/v1/workforce/organizations/:organizationId/workflows (approval workflows)
// Mounted under the Workforce tenant router.
//
// Who can do what (migration 20261112090000_workforce_workflows):
//   every staff role (workforce.self):     see the requests they raised or must decide, decide their steps,
//                                          withdraw their own requests, start approval for a connected document
//   HR officer, hospital admin, owner:     design and switch on workflows, test runs, see and cancel every
//   (workflow.manage)                      request, run escalations
// The service checks whose step it is; the route permission is only the outer gate.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../../emr/core/context.js';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as workflows from './workflows.service.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const key = z.string().min(1).max(60).regex(/^[\w.:-]+$/, 'Use letters, digits, - _ . or :');
const trigger = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'Use a lowercase approval type, e.g. leave');
const approverType = z.enum(['initiator', 'line-manager', 'hod', 'deputy-hod', 'department-role', 'specific-person', 'role']);
const node = z.object({
  id: key, type: z.enum(['start', 'approval', 'review', 'condition', 'parallel', 'notify', 'escalation', 'end']), label: text(160),
  x: z.number().min(-10000).max(10000), y: z.number().min(-10000).max(10000),
  approverType: approverType.optional(), approverRef: z.string().trim().max(120).optional(),
  joinMode: z.enum(['all', 'any', 'quorum']).optional(), quorum: z.number().int().min(1).max(20).optional(),
  members: z.array(z.object({ approverType, approverRef: z.string().trim().max(120).optional(), label: text(120) }).strict()).max(20).optional(),
  conditions: z.array(z.object({ id: key, field: key, op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']), value: z.union([z.string().max(200), z.number()]) }).strict()).max(20).optional(),
  conditionMatch: z.enum(['all', 'any']).optional(), afterHours: z.number().min(1).max(2000).optional(),
  notifyText: z.string().trim().max(300).optional(), outcome: z.enum(['approved', 'rejected']).optional(),
}).strict();
const edge = z.object({ id: key, from: key, to: key, branch: z.enum(['approve', 'reject', 'true', 'false', 'timeout', 'default']), label: z.string().trim().max(60).optional() }).strict();
const contextValue = z.union([z.string().max(200), z.number(), z.boolean()]);

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  createDef: body({ id: z.uuid().optional(), name: text(120), triggerType: trigger, description: z.string().trim().max(500).optional() }),
  saveDef: z.object({
    params: z.object(withId).strict(), query: noQuery,
    body: z.object({ name: text(120).optional(), description: z.string().trim().max(500).optional(), triggerType: trigger.optional(), nodes: z.array(node).max(60).optional(), edges: z.array(edge).max(120).optional() }).strict()
      .refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
  }),
  active: body({ active: z.boolean() }, withId),
  start: z.object({
    params: z.object(org).strict(), query: noQuery,
    body: z.object({
      triggerType: trigger, reference: z.string().trim().min(1).max(100).optional(), subject: text(300).optional(), defId: z.uuid().optional(),
      context: z.record(key, contextValue).refine((c) => Object.keys(c).length <= 40, 'At most 40 context fields').optional(),
    }).strict().refine((b) => b.context || b.reference, 'Send the document reference (or a test-run context)'),
  }),
  decide: body({ nodeId: key, decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(500).optional() }, withId),
  cancel: body({ reason: z.string().trim().max(500).optional() }, withId),
  tick: body({}),
};

const MANAGE = ['workflow.manage'];
const ANYONE = ['workforce.self', 'workflow.manage'];
export const workflowRoutes = express.Router({ mergeParams: true });
const r = (method, path, schema, perms, fn, status = 200) => workflowRoutes[method](path, check(schema), allow(...perms), handle(async (req, res) => send(res, await fn(req), status)));

r('get', '/', v.overview, ANYONE, (req) => workflows.overview(req.emr));
r('post', '/defs', v.createDef, MANAGE, (req) => workflows.createDef(req.emr, req.body), 201);
workflowRoutes.put('/defs/:id', check(v.saveDef), allow(...MANAGE), handle(async (req, res) => send(res, await workflows.saveDef(req.emr, req.params.id, requireVersion(req), req.body))));
r('post', '/defs/:id/active', v.active, MANAGE, (req) => workflows.setDefActive(req.emr, req.params.id, req.body));
r('post', '/instances', v.start, ANYONE, (req) => workflows.start(req.emr, req.body), 201);
r('post', '/instances/:id/decide', v.decide, ANYONE, (req) => workflows.decide(req.emr, req.params.id, req.body));
r('post', '/instances/:id/cancel', v.cancel, ANYONE, (req) => workflows.cancel(req.emr, req.params.id, req.body));
r('post', '/escalations', v.tick, MANAGE, (req) => workflows.runEscalations(req.emr));
