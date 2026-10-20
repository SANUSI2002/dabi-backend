// /api/v1/emr/organizations/:organizationId/equipment (asset register and maintenance)
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261108090000_emr_assets):
//   inventory officer, hospital admin:                          everything below
//   doctor, nurse, lab scientist, pharmacist, radiographer:     see; report a fault
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as assets from './assets.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const STATUS = z.enum(['IN_SERVICE', 'UNDER_REPAIR', 'OUT_OF_SERVICE', 'RETIRED']);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const asset = { ...org, assetId: z.uuid() };
const job = { ...org, jobId: z.uuid() };
const v = {
  list: z.object({ params: z.object(org).strict(), query: noQuery }),
  add: body({
    tag: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_\-/]{0,29}$/, 'Tags are letters, digits, -, / and _'), name: text(120), category: z.enum(assets.ASSET_CATEGORIES),
    location: text(120), serialNumber: text(60).optional(), costMinor: z.number().int().min(0).max(1_000_000_000_000).optional(),
    commissionedOn: z.iso.date(), lastServicedOn: z.iso.date(), serviceIntervalDays: z.number().int().min(1).max(3650), status: STATUS.optional(),
  }),
  status: body({ status: STATUS }, asset),
  fault: body({ assetId: z.uuid(), summary: text(1000), priority: z.enum(['LOW', 'MEDIUM', 'HIGH']) }),
  start: body({}, job),
  resolve: body({ resolution: text(1000) }, job),
  schedulePm: body({}, asset),
  service: body({ note: z.string().trim().max(1000).optional() }, asset),
};

export const equipmentRoutes = express.Router({ mergeParams: true });
equipmentRoutes.get('/', check(v.list), allow('equipment.read'), handle(async (req, res) => send(res, await assets.listEquipment(req.emr))));
equipmentRoutes.post('/assets', check(v.add), allow('equipment.manage'), handle(async (req, res) => sendResult(res, await assets.addAsset(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
equipmentRoutes.post('/assets/:assetId/status', check(v.status), allow('equipment.manage'), handle(async (req, res) => send(res, await assets.setAssetStatus(req.emr, req.params.assetId, requireVersion(req), req.body))));
equipmentRoutes.post('/assets/:assetId/pm-jobs', check(v.schedulePm), allow('equipment.manage'), handle(async (req, res) => send(res, await assets.schedulePm(req.emr, req.params.assetId), 201)));
equipmentRoutes.post('/assets/:assetId/service', check(v.service), allow('equipment.manage'), handle(async (req, res) => send(res, await assets.logService(req.emr, req.params.assetId, req.body))));
equipmentRoutes.post('/faults', check(v.fault), allow('equipment.report'), handle(async (req, res) => sendResult(res, await assets.reportFault(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
equipmentRoutes.post('/jobs/:jobId/start', check(v.start), allow('equipment.manage'), handle(async (req, res) => send(res, await assets.startJob(req.emr, req.params.jobId, requireVersion(req)))));
equipmentRoutes.post('/jobs/:jobId/resolve', check(v.resolve), allow('equipment.manage'), handle(async (req, res) => send(res, await assets.resolveJob(req.emr, req.params.jobId, requireVersion(req), req.body))));
