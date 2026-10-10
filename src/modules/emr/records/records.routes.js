// /api/v1/emr/organizations/:organizationId/patients/:patientId/record|problems
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261018090000_emr_patient_record):
//   doctor, nurse: read the record (sections they may not see otherwise come back as null)
//   doctor:        add problems and change their status
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send } from '../core/http.js';
import * as v from './records.validator.js';
import * as records from './records.service.js';

export const patientRecordRoutes = express.Router({ mergeParams: true });

patientRecordRoutes.get('/record', check(v.record), allow('clinical.read'),
  handle(async (req, res) => send(res, await records.patientRecord(req.emr, req.params.patientId))));
patientRecordRoutes.post('/problems', check(v.addProblem), allow('diagnosis.record'),
  handle(async (req, res) => send(res, await records.addProblem(req.emr, req.params.patientId, req.body), 201)));
patientRecordRoutes.patch('/problems/:problemId', check(v.updateProblem), allow('diagnosis.record'),
  handle(async (req, res) => send(res, await records.updateProblem(req.emr, req.params.patientId, req.params.problemId, requireVersion(req), req.body))));
