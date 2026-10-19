// /api/v1/emr/organizations/:organizationId/postnatal
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261027090000_emr_postnatal):
//   doctor, nurse:  see visits and contacts due, record visits, mark one entered-in-error
//   hospital admin: see
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './postnatal.validator.js';
import * as pnc from './postnatal.service.js';

export const postnatalRoutes = express.Router({ mergeParams: true });
postnatalRoutes.get('/', check(v.list), allow('pnc.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await pnc.listVisits(req.emr, req.query) })));
postnatalRoutes.get('/due', check(v.due), allow('pnc.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await pnc.contactsDue(req.emr) })));
postnatalRoutes.post('/', check(v.record), allow('pnc.record'),
  handle(async (req, res) => sendResult(res, await pnc.recordVisit(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
postnatalRoutes.post('/:visitId/entered-in-error', check(v.enteredInError), allow('pnc.record'),
  handle(async (req, res) => send(res, await pnc.markVisitEnteredInError(req.emr, req.params.visitId, req.body))));
