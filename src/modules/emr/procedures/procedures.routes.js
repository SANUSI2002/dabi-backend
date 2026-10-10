// /api/v1/emr/organizations/:organizationId/procedures
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261021090000_emr_procedures):
//   doctor, nurse:  request, and carry a procedure through (schedule, consent, checklist, perform,
//                   recovery, follow-up, cancel); the performer signs the note; amendments after
//   hospital admin: see
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './procedures.validator.js';
import * as procedures from './procedures.service.js';

export const procedureRoutes = express.Router({ mergeParams: true });
const step = (validator, run) => [check(validator), allow('procedure.perform'),
  handle(async (req, res) => send(res, await run(req.emr, req.params.procedureId, requireVersion(req), req.body)))];

procedureRoutes.get('/', check(v.list), allow('procedure.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await procedures.listProcedures(req.emr, req.query) })));
procedureRoutes.post('/', check(v.request), allow('procedure.order.create'),
  handle(async (req, res) => sendResult(res, await procedures.requestProcedure(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
procedureRoutes.post('/:procedureId/schedule', ...step(v.schedule, procedures.scheduleProcedure));
procedureRoutes.post('/:procedureId/consent', ...step(v.consent, procedures.recordConsent));
procedureRoutes.put('/:procedureId/checklist/:itemId', check(v.checklistItem), allow('procedure.perform'),
  handle(async (req, res) => send(res, await procedures.setChecklistItem(req.emr, req.params.procedureId, req.params.itemId, req.body))));
procedureRoutes.post('/:procedureId/pre-procedure', ...step(v.transition, (ctx, id, version) => procedures.beginPreProcedure(ctx, id, version)));
procedureRoutes.post('/:procedureId/perform', ...step(v.perform, procedures.performProcedure));
procedureRoutes.post('/:procedureId/recovery', ...step(v.recovery, procedures.recordRecovery));
procedureRoutes.post('/:procedureId/follow-up', ...step(v.followUp, procedures.setFollowUp));
procedureRoutes.post('/:procedureId/sign', ...step(v.transition, (ctx, id, version) => procedures.signNote(ctx, id, version)));
procedureRoutes.post('/:procedureId/amendments', check(v.amend), allow('procedure.perform'),
  handle(async (req, res) => send(res, await procedures.amendNote(req.emr, req.params.procedureId, req.body), 201)));
procedureRoutes.post('/:procedureId/cancel', check(v.cancel), allow('procedure.perform', 'procedure.order.create'),
  handle(async (req, res) => send(res, await procedures.cancelProcedure(req.emr, req.params.procedureId, requireVersion(req), req.body))));
