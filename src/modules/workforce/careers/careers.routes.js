// /api/v1/workforce/organizations/:organizationId/careers (performance, promotions, branch transfers)
// Mounted under the Workforce tenant router.
//
// Who can do what (migrations 20261110090000_workforce_people, 20261114090000_workforce_careers):
//   HR (hr.read / hr.manage):   everything; promotions and transfers are HR's
//   every staff role:           their own objectives, reviews and 1-on-1s — and, as a named manager,
//   (workforce.self)            starting reviews and 1-on-1s with their people (the service checks)
// Promotion/transfer approval runs through the "promotion" / "transfer" workflows; a rejected one is
// resubmitted with POST /workflows/instances { triggerType, reference }.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../../emr/core/context.js';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { send } from '../../emr/core/http.js';
import * as careers from './careers.service.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const date = z.iso.date();
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const clientId = { id: z.uuid().optional() };
const answers = z.array(z.object({ question: text(200), rating: z.number().int().min(1).max(5), comment: free(1000).optional() }).strict()).min(1).max(20);
const kind = z.enum(['promotions', 'transfers']);
const changeId = { ...org, kind, id: z.uuid() };

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  period: body({ ...clientId, name: text(80), startDate: date, endDate: date }),
  objective: body({
    ...clientId, title: text(160), description: free(2000).optional(), managerIds: z.array(z.uuid()).max(10), assigneeIds: z.array(z.uuid()).min(1).max(200),
    keyResultIds: z.array(z.uuid()).min(1).max(20), durationUnit: z.enum(['Days', 'Months', 'Years']), duration: z.number().int().min(1).max(3650),
  }),
  progress: body({ keyResultId: z.string().min(1).max(80), currentValue: z.number().min(0).max(1e9) }, withId),
  status: body({ status: z.enum(['Not Started', 'On Track', 'Behind', 'At Risk', 'Closed']) }, withId),
  feedback: body({ ...clientId, reviewCycle: text(80), employeeId: z.uuid(), managerId: z.uuid().optional(), colleagueIds: z.array(z.uuid()).max(20).default([]) }),
  answer: body({ role: z.enum(['self', 'manager']), answers }, withId),
  meeting: body({ ...clientId, title: text(120), employeeId: z.uuid(), managerId: z.uuid(), scheduledAt: z.iso.datetime({ offset: true }) }),
  completeMeeting: body({ notes: text(4000), actionItems: free(4000).optional() }, withId),
  promotion: body({
    ...clientId, employeeId: z.uuid(), toJobPositionId: z.uuid().optional(), toJobRoleId: z.uuid().optional(), toCadre: text(80).optional(),
    newSalary: z.number().positive().max(1e12).optional(), effectiveDate: date, reason: text(2000),
  }).refine((r) => r.body.toJobPositionId || r.body.toJobRoleId || r.body.toCadre, 'Choose the new position, role or cadre'),
  transfer: body({ ...clientId, employeeId: z.uuid(), toCompanyId: z.uuid(), effectiveDate: date, reason: text(2000) }),
  apply: body({}, changeId),
  handover: body({ successorId: z.uuid().optional(), notes: free(4000).optional(), complete: z.boolean().optional() }, changeId)
    .refine((r) => r.body.complete || r.body.successorId, 'Name the successor, or mark the handover complete'),
};

const HR = ['hr.read', 'hr.manage'];
const STAFF = ['workforce.self', 'hr.read'];
export const careerRoutes = express.Router({ mergeParams: true });
const r = (method, path, schema, perms, fn, status = 200) => careerRoutes[method](path, check(schema), allow(...perms), handle(async (req, res) => send(res, await fn(req), status)));
const KIND = { promotions: 'promotion', transfers: 'transfer' };

r('get', '/', v.overview, STAFF, (req) => careers.overview(req.emr));
r('post', '/periods', v.period, HR, (req) => careers.addPeriod(req.emr, req.body), 201);
r('post', '/objectives', v.objective, HR, (req) => careers.addObjective(req.emr, req.body), 201);
r('post', '/employee-objectives/:id/progress', v.progress, STAFF, (req) => careers.updateKeyResult(req.emr, req.params.id, req.body));
r('post', '/employee-objectives/:id/status', v.status, STAFF, (req) => careers.setObjectiveStatus(req.emr, req.params.id, req.body));
r('post', '/feedback', v.feedback, STAFF, (req) => careers.startFeedback(req.emr, req.body), 201);
r('post', '/feedback/:id/answers', v.answer, STAFF, (req) => careers.submitFeedback(req.emr, req.params.id, req.body));
r('post', '/meetings', v.meeting, STAFF, (req) => careers.scheduleMeeting(req.emr, req.body), 201);
r('post', '/meetings/:id/complete', v.completeMeeting, STAFF, (req) => careers.completeMeeting(req.emr, req.params.id, req.body));
r('post', '/promotions', v.promotion, HR, (req) => careers.proposePromotion(req.emr, req.body), 201);
r('post', '/transfers', v.transfer, HR, (req) => careers.proposeTransfer(req.emr, req.body), 201);
r('post', '/:kind/:id/apply', v.apply, HR, (req) => careers.applyChange(req.emr, KIND[req.params.kind], req.params.id));
r('post', '/:kind/:id/handover', v.handover, HR, (req) => careers.recordHandover(req.emr, KIND[req.params.kind], req.params.id, req.body));
