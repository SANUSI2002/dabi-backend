// Laboratory routes.
//   /api/v1/emr/organizations/:organizationId/lab/...                      (catalog, worklist, workflow)
//   /api/v1/emr/organizations/:organizationId/encounters/:encounterId/lab-orders  (order + view in a visit)
//
// Who can do what (migration 20260930090000_emr_lab):
//   doctor:        order tests, read results, acknowledge released results
//   nurse:         read, collect specimens
//   lab scientist: worklist, collect, enter, return, verify, amend, record critical calls, manage the catalog
//   hospital admin: manage the catalog
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendItems, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './lab.validator.js';
import * as service from './lab.service.js';

export const labRoutes = express.Router({ mergeParams: true });

labRoutes.get('/tests', check(v.listTests), allow('lab.order.create', 'lab.order.read', 'lab.catalog.manage'),
  handle(async (req, res) => sendItems(res, await service.listTests(req.emr, req.query))));
labRoutes.post('/tests', check(v.createTest), allow('lab.catalog.manage'),
  handle(async (req, res) => send(res, await service.createTest(req.emr, req.body), 201)));
labRoutes.patch('/tests/:code', check(v.updateTest), allow('lab.catalog.manage'),
  handle(async (req, res) => send(res, await service.updateTest(req.emr, req.params.code, requireVersion(req), req.body))));

labRoutes.get('/orders', check(v.worklist), allow('lab.order.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await service.worklist(req.emr, req.query) })));
labRoutes.get('/orders/:orderId', check(v.oneOrder), allow('lab.order.read'),
  handle(async (req, res) => send(res, await service.getOrder(req.emr, req.params.orderId))));
labRoutes.post('/orders/:orderId/collect', check(v.collect), allow('lab.specimen.collect'),
  handle(async (req, res) => send(res, await service.collectSpecimen(req.emr, req.params.orderId, requireVersion(req), req.body))));
labRoutes.post('/orders/:orderId/cancel', check(v.cancel), allow('lab.order.create', 'lab.result.verify'),
  handle(async (req, res) => send(res, await service.cancelOrder(req.emr, req.params.orderId, requireVersion(req), req.body))));

// Result actions take the ordered test's version in If-Match (each test is versioned separately).
labRoutes.put('/orders/:orderId/items/:itemId/results', check(v.enterResults), allow('lab.result.create'),
  handle(async (req, res) => send(res, await service.enterResults(req.emr, req.params.orderId, req.params.itemId, requireVersion(req), req.body))));
labRoutes.post('/orders/:orderId/items/:itemId/verify', check(v.verify), allow('lab.result.verify'),
  handle(async (req, res) => send(res, await service.verifyResults(req.emr, req.params.orderId, req.params.itemId, requireVersion(req)))));
labRoutes.post('/orders/:orderId/items/:itemId/amend', check(v.amend), allow('lab.result.verify'),
  handle(async (req, res) => send(res, await service.amendResults(req.emr, req.params.orderId, req.params.itemId, requireVersion(req), req.body))));
labRoutes.post('/orders/:orderId/items/:itemId/return', check(v.returnResults), allow('lab.result.verify'),
  handle(async (req, res) => send(res, await service.returnForCorrection(req.emr, req.params.orderId, req.params.itemId, requireVersion(req), req.body))));
labRoutes.post('/orders/:orderId/items/:itemId/acknowledge', check(v.acknowledge), allow('lab.order.create'),
  handle(async (req, res) => send(res, await service.acknowledgeResults(req.emr, req.params.orderId, req.params.itemId, requireVersion(req)))));
labRoutes.post('/orders/:orderId/items/:itemId/communicate', check(v.communicate), allow('lab.result.verify'),
  handle(async (req, res) => send(res, await service.communicateCritical(req.emr, req.params.orderId, req.params.itemId, requireVersion(req), req.body))));

export const encounterLabRoutes = express.Router({ mergeParams: true });

encounterLabRoutes.get('/', check(v.encounterOrders), allow('clinical.read', 'lab.order.read'),
  handle(async (req, res) => sendItems(res, await service.listEncounterOrders(req.emr, req.params.encounterId))));
encounterLabRoutes.post('/', check(v.orderTests), allow('lab.order.create'),
  handle(async (req, res) => sendResult(res, await service.orderTests(req.emr, req.params.encounterId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
