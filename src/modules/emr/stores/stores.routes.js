// /api/v1/emr/organizations/:organizationId/stores (hospital stores: general inventory)
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261107090000_emr_stores):
//   inventory officer:                    everything below
//   hospital admin:                       see; approve, reject and fulfil requisitions
//   nurse, lab scientist, pharmacist:     see; raise and submit requisitions
//   doctor:                               see
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as stores from './stores.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const qty = z.number().int().min(1).max(10_000_000);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const withId = (key) => ({ ...org, [key]: z.uuid() });
const itemFields = {
  name: text(120), category: text(40), unit: text(20), // a Store Item Categories item (checked by the service)
  minLevel: z.number().int().min(0).max(10_000_000).nullable().optional(), reorderLevel: z.number().int().min(0).max(10_000_000).optional(),
  reorderQty: z.number().int().min(1).max(10_000_000).nullable().optional(),
};
const v = {
  overview: z.object({ params: z.object(org).strict(), query: z.object({ movementLimit: z.coerce.number().int().min(1).max(2000).default(500) }).strict() }),
  createItem: body({ sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,29}$/, 'SKUs are letters, digits, - and _'), ...itemFields }),
  updateItem: z.object({
    params: z.object(withId('itemId')).strict(), query: noQuery,
    body: z.object({ ...Object.fromEntries(Object.entries(itemFields).map(([k, s]) => [k, s.optional()])), active: z.boolean().optional() }).strict()
      .refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
  }),
  createLocation: body({ code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,11}$/, 'Codes are letters, digits and _ (up to 12)'), name: text(80), type: z.enum(['STORE', 'DEPARTMENT', 'WARD']) }),
  locationStatus: body({ status: z.enum(['ACTIVE', 'INACTIVE']) }, withId('locationId')),
  receive: body({
    itemId: z.uuid(), locationId: z.uuid(), qty, unitCostMinor: z.number().int().min(0).max(1_000_000_000_000),
    batchNumber: text(60).optional(), expiryDate: z.iso.date().optional(), reference: text(80).optional(), note: text(500).optional(),
  }),
  issue: body({ itemId: z.uuid(), locationId: z.uuid(), qty, department: text(80).optional(), purpose: text(200).optional(), reference: text(80).optional() }),
  adjust: body({ itemId: z.uuid(), locationId: z.uuid(), qtyDelta: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'The adjustment cannot be zero'), reason: text(500) }),
  writeOff: body({ itemId: z.uuid(), qty, reason: text(500), locationId: z.uuid().optional(), batchId: z.uuid().optional() }),
  quarantine: body({ reason: text(300) }, withId('batchId')),
  release: body({}, withId('batchId')),
  recall: body({ itemId: z.uuid(), batchNumber: text(60), reason: text(280) }),
  transfer: body({ itemId: z.uuid(), qty, fromLocationId: z.uuid(), toLocationId: z.uuid(), reference: text(80).optional() }),
  createRequisition: body({
    requestingLocationId: z.uuid(), neededBy: z.iso.date().optional(), justification: text(500).optional(), submit: z.boolean().default(false),
    lines: z.array(z.object({ itemId: z.uuid(), qtyRequested: qty }).strict()).min(1).max(50)
      .refine((lines) => new Set(lines.map((l) => l.itemId)).size === lines.length, 'List each item once'),
  }),
  stepRequisition: body({}, withId('requisitionId')),
  rejectRequisition: body({ reason: text(500) }, withId('requisitionId')),
  fulfilRequisition: body({ fulfillingLocationId: z.uuid() }, withId('requisitionId')),
  createCount: body({ id: z.uuid().optional(), locationId: z.uuid(), itemIds: z.array(z.uuid()).min(1).max(500).refine((ids) => new Set(ids).size === ids.length, 'List each item once'), note: text(500).optional() }),
  countLine: body({ itemId: z.uuid(), countedQty: z.number().int().min(0).max(10_000_000) }, withId('countId')),
  postCount: body({}, withId('countId')),
};
const key = (req) => ({ idempotencyKey: readIdempotencyKey(req) });

export const storeRoutes = express.Router({ mergeParams: true });
storeRoutes.get('/', check(v.overview), allow('stores.read'), handle(async (req, res) => send(res, await stores.overview(req.emr, req.query))));

storeRoutes.post('/items', check(v.createItem), allow('stores.manage'), handle(async (req, res) => send(res, await stores.createItem(req.emr, req.body), 201)));
storeRoutes.patch('/items/:itemId', check(v.updateItem), allow('stores.manage'), handle(async (req, res) => send(res, await stores.updateItem(req.emr, req.params.itemId, requireVersion(req), req.body))));
storeRoutes.post('/locations', check(v.createLocation), allow('stores.manage'), handle(async (req, res) => send(res, await stores.createLocation(req.emr, req.body), 201)));
storeRoutes.post('/locations/:locationId/status', check(v.locationStatus), allow('stores.manage'), handle(async (req, res) => send(res, await stores.setLocationStatus(req.emr, req.params.locationId, requireVersion(req), req.body))));

storeRoutes.post('/receipts', check(v.receive), allow('stores.manage'), handle(async (req, res) => sendResult(res, await stores.receive(req.emr, req.body, key(req)))));
storeRoutes.post('/issues', check(v.issue), allow('stores.manage'), handle(async (req, res) => sendResult(res, await stores.issue(req.emr, req.body, key(req)))));
storeRoutes.post('/adjustments', check(v.adjust), allow('stores.manage'), handle(async (req, res) => sendResult(res, await stores.adjust(req.emr, req.body, key(req)))));
storeRoutes.post('/write-offs', check(v.writeOff), allow('stores.manage'), handle(async (req, res) => sendResult(res, await stores.writeOff(req.emr, req.body, key(req)))));
storeRoutes.post('/transfers', check(v.transfer), allow('stores.manage'), handle(async (req, res) => sendResult(res, await stores.transfer(req.emr, req.body, key(req)))));
storeRoutes.post('/batches/:batchId/quarantine', check(v.quarantine), allow('stores.manage'), handle(async (req, res) => send(res, await stores.quarantine(req.emr, req.params.batchId, req.body))));
storeRoutes.post('/batches/:batchId/release', check(v.release), allow('stores.manage'), handle(async (req, res) => send(res, await stores.release(req.emr, req.params.batchId))));
storeRoutes.post('/recalls', check(v.recall), allow('stores.manage'), handle(async (req, res) => send(res, await stores.recallLot(req.emr, req.body))));

storeRoutes.post('/requisitions', check(v.createRequisition), allow('stores.requisition'), handle(async (req, res) => sendResult(res, await stores.createRequisition(req.emr, req.body, key(req)))));
storeRoutes.post('/requisitions/:requisitionId/submit', check(v.stepRequisition), allow('stores.requisition'), handle(async (req, res) => send(res, await stores.stepRequisition(req.emr, req.params.requisitionId, requireVersion(req), 'submit'))));
storeRoutes.post('/requisitions/:requisitionId/cancel', check(v.stepRequisition), allow('stores.requisition', 'stores.approve'), handle(async (req, res) => send(res, await stores.stepRequisition(req.emr, req.params.requisitionId, requireVersion(req), 'cancel'))));
storeRoutes.post('/requisitions/:requisitionId/approve', check(v.stepRequisition), allow('stores.approve'), handle(async (req, res) => send(res, await stores.stepRequisition(req.emr, req.params.requisitionId, requireVersion(req), 'approve'))));
storeRoutes.post('/requisitions/:requisitionId/reject', check(v.rejectRequisition), allow('stores.approve'), handle(async (req, res) => send(res, await stores.stepRequisition(req.emr, req.params.requisitionId, requireVersion(req), 'reject', req.body))));
storeRoutes.post('/requisitions/:requisitionId/fulfil', check(v.fulfilRequisition), allow('stores.approve'), handle(async (req, res) => send(res, await stores.fulfilRequisition(req.emr, req.params.requisitionId, requireVersion(req), req.body))));

storeRoutes.post('/counts', check(v.createCount), allow('stores.manage'), handle(async (req, res) => send(res, await stores.createCount(req.emr, req.body), 201)));
storeRoutes.post('/counts/:countId/lines', check(v.countLine), allow('stores.manage'), handle(async (req, res) => send(res, await stores.recordCountLine(req.emr, req.params.countId, req.body))));
storeRoutes.post('/counts/:countId/post', check(v.postCount), allow('stores.manage'), handle(async (req, res) => send(res, await stores.postCount(req.emr, req.params.countId, requireVersion(req)))));
