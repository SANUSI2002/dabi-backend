// /api/v1/emr/organizations/:organizationId/reports
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261105090000_emr_reports):
//   hospital admin, owner: view reports and counts; save and compile the Monthly Summary Form
//   doctor, nurse:         view reports and counts
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send } from '../core/http.js';
import * as reports from './reports.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const period = z.object({ from: z.iso.date(), to: z.iso.date() }).strict()
  .refine((q) => q.from <= q.to, { path: ['to'], message: 'The end date must not be before the start date.' })
  .refine((q) => new Date(q.to) - new Date(q.from) <= 400 * 86_400_000, { path: ['to'], message: 'Choose a period of at most 400 days.' });
const month = { ...org, period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') };
const v = {
  period: z.object({ params: z.object(org).strict(), query: period }),
  msf: z.object({ params: z.object(month).strict(), query: noQuery }),
  saveMsf: z.object({
    params: z.object(month).strict(),
    query: noQuery,
    body: z.object({ values: z.record(z.string().min(1).max(60), z.number().int().min(0).max(10_000_000)).refine((r) => Object.keys(r).length <= 60, 'Too many fields') }).strict(),
  }),
  compileMsf: z.object({ params: z.object(month).strict(), query: noQuery, body: z.object({}).strict() }),
};
const optionalVersion = (req) => (req.get('if-match') ? requireVersion(req) : undefined);

export const reportRoutes = express.Router({ mergeParams: true });
reportRoutes.get('/source', check(v.period), allow('report.view'),
  handle(async (req, res) => send(res, await reports.reportSource(req.emr, req.query))));
reportRoutes.get('/counts', check(v.period), allow('report.view'),
  handle(async (req, res) => send(res, await reports.periodCounts(req.emr, req.query))));
reportRoutes.get('/msf/:period', check(v.msf), allow('report.view'),
  handle(async (req, res) => send(res, await reports.getMsf(req.emr, req.params.period))));
reportRoutes.put('/msf/:period', check(v.saveMsf), allow('report.compile'),
  handle(async (req, res) => send(res, await reports.saveMsf(req.emr, req.params.period, optionalVersion(req), req.body))));
reportRoutes.post('/msf/:period/compile', check(v.compileMsf), allow('report.compile'),
  handle(async (req, res) => send(res, await reports.compileMsf(req.emr, req.params.period, requireVersion(req)))));
