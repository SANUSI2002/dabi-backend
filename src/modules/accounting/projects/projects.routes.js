// /api/v1/accounting/organizations/:organizationId/{projects,notification-prefs}
// Projects: read with acct.view; created, changed and time logged with acct.post (billing time is an
// invoice, through receivables). Notification preferences: the signed-in user's own.
import express from 'express';
import { z } from 'zod';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as prj from './projects.service.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const when = z.iso.datetime({ offset: true }).or(z.iso.date());
const STATUS = z.enum(['Active', 'On Hold', 'Completed', 'Cancelled']);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const project = { name: text(160), customerId: z.uuid().optional(), status: STATUS.optional(), startDate: when, endDate: when.optional(), budgetAmount: z.number().min(0).max(1e13).optional(), billable: z.boolean(), description: free(2000).optional() };

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  project: body({ id: z.uuid().optional(), code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/), ...project }),
  updateProject: z.object({
    params: z.object(withId).strict(), query: noQuery,
    body: z.object({ ...Object.fromEntries(Object.entries(project).map(([k, s]) => [k, s.optional()])), endDate: when.nullable().optional() }).strict().refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
  }),
  time: body({ id: z.uuid().optional(), projectId: z.uuid(), staffId: z.uuid(), date: when, hours: z.number().positive().max(24), description: text(300), billable: z.boolean(), rate: z.number().min(0).max(1e9).optional(), revenueAccount: z.number().int().min(4000).max(4999) }),
  empty: body({}, withId),
  prefs: body({ ...Object.fromEntries(['approvalPending', 'invoiceOverdue', 'billDueSoon', 'lowStock', 'budgetExceeded', 'largeJournal'].map((k) => [k, z.boolean()])), emailDigest: z.boolean().optional() }),
};

export const projectRoutes = express.Router({ mergeParams: true });
const r = (router, method, path, schema, fn, status = 200) => router[method](path, check(schema), handle(async (req, res) => send(res, await fn(req), status)));
r(projectRoutes, 'get', '/', v.overview, (req) => prj.overview(req.emr));
r(projectRoutes, 'post', '/', v.project, (req) => prj.addProject(req.emr, req.body), 201);
projectRoutes.patch('/:id', check(v.updateProject), handle(async (req, res) => send(res, await prj.updateProject(req.emr, req.params.id, requireVersion(req), req.body))));
r(projectRoutes, 'post', '/time', v.time, (req) => prj.addTimeEntry(req.emr, req.body), 201);
r(projectRoutes, 'post', '/time/:id/remove', v.empty, (req) => prj.removeTimeEntry(req.emr, req.params.id));

export const prefsRoutes = express.Router({ mergeParams: true });
r(prefsRoutes, 'put', '/', v.prefs, (req) => prj.savePrefs(req.emr, req.body));
