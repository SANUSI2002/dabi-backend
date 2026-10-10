// /api/v1/emr/organizations/:organizationId/imaging/studies
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261020090000_emr_radiology):
//   doctor, nurse:  request imaging, see studies and reports, cancel a request not yet performed
//   radiographer:   schedule, perform (record series), cancel
//   radiologist:    + report, verify, addenda, comparisons
//   hospital admin: see
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './radiology.validator.js';
import * as radiology from './radiology.service.js';

export const imagingRoutes = express.Router({ mergeParams: true });
const change = (validator, permissions, run) => [check(validator), allow(...permissions),
  handle(async (req, res) => send(res, await run(req.emr, req.params.studyId, requireVersion(req), req.body)))];

imagingRoutes.get('/studies', check(v.list), allow('imaging.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await radiology.listStudies(req.emr, req.query) })));
imagingRoutes.post('/studies', check(v.request), allow('imaging.order.create'),
  handle(async (req, res) => sendResult(res, await radiology.requestStudy(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
imagingRoutes.post('/studies/:studyId/schedule', ...change(v.schedule, ['imaging.perform'], radiology.scheduleStudy));
imagingRoutes.post('/studies/:studyId/perform', ...change(v.perform, ['imaging.perform'], radiology.performStudy));
imagingRoutes.post('/studies/:studyId/report', ...change(v.report, ['imaging.report'], radiology.reportStudy));
imagingRoutes.post('/studies/:studyId/verify', ...change(v.verify, ['imaging.report'], (ctx, id, version) => radiology.verifyReport(ctx, id, version)));
imagingRoutes.post('/studies/:studyId/addenda', ...change(v.addendum, ['imaging.report'], radiology.addAddendum));
imagingRoutes.post('/studies/:studyId/cancel', ...change(v.cancel, ['imaging.perform', 'imaging.order.create'], radiology.cancelStudy));
imagingRoutes.put('/studies/:studyId/comparison', ...change(v.comparison, ['imaging.report', 'imaging.perform'], radiology.setComparison));
