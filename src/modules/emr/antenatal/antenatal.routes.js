// /api/v1/emr/organizations/:organizationId/antenatal
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261025090000_emr_antenatal):
//   doctor, nurse:  see, enrol, record visits, mark a visit entered-in-error, close a pregnancy
//   hospital admin: see
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './antenatal.validator.js';
import * as anc from './antenatal.service.js';

export const antenatalRoutes = express.Router({ mergeParams: true });

antenatalRoutes.get('/', check(v.list), allow('anc.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await anc.listPregnancies(req.emr, req.query) })));
antenatalRoutes.post('/', check(v.enrol), allow('anc.manage'),
  handle(async (req, res) => sendResult(res, await anc.enrolPregnancy(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
antenatalRoutes.post('/:pregnancyId/visits', check(v.visit), allow('anc.manage'),
  handle(async (req, res) => sendResult(res, await anc.recordVisit(req.emr, req.params.pregnancyId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
antenatalRoutes.post('/:pregnancyId/visits/:visitId/entered-in-error', check(v.enteredInError), allow('anc.manage'),
  handle(async (req, res) => send(res, await anc.markVisitEnteredInError(req.emr, req.params.pregnancyId, req.params.visitId, req.body))));
antenatalRoutes.post('/:pregnancyId/close', check(v.close), allow('anc.manage'),
  handle(async (req, res) => send(res, await anc.closePregnancy(req.emr, req.params.pregnancyId, requireVersion(req), req.body))));
