// Wards, beds, admissions and the MAR.
//   /api/v1/emr/organizations/:organizationId/wards/...                        wards, beds, census
//   /api/v1/emr/organizations/:organizationId/beds/:bedId/status               housekeeping
//   /api/v1/emr/organizations/:organizationId/encounters/:encounterId/admission admit from a visit
//   /api/v1/emr/organizations/:organizationId/admissions/...                   census, transfer, discharge, MAR
//
// Who can do what (migration 20261002090000_emr_admissions):
//   hospital admin: wards/beds, bed status, census
//   doctor:        admit, transfer, discharge, cancel an admission, chart medicines
//   nurse:         transfer, bed status, chart medicines, census
//   reception:     census
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { etagFor, requireVersion } from '../core/concurrency.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './admissions.validator.js';
import * as admissions from './admissions.service.js';
import * as mar from './mar.service.js';

const send = (res, data, status = 200) => {
  if (data?.version) res.set('ETag', etagFor(data.version));
  res.status(status).json({ status: 'success', data });
};
const sendResult = (res, result) => {
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  send(res, result.body, result.statusCode);
};

export const wardRoutes = express.Router({ mergeParams: true });
wardRoutes.get('/', check(v.listWards), allow('admission.read', 'ward.manage'),
  handle(async (req, res) => res.json({ status: 'success', data: { items: await admissions.listWards(req.emr, req.query) } })));
wardRoutes.post('/', check(v.createWard), allow('ward.manage'),
  handle(async (req, res) => send(res, await admissions.createWard(req.emr, req.body), 201)));
wardRoutes.patch('/:wardId', check(v.updateWard), allow('ward.manage'),
  handle(async (req, res) => send(res, await admissions.updateWard(req.emr, req.params.wardId, requireVersion(req), req.body))));
wardRoutes.get('/:wardId/beds', check(v.oneWard), allow('admission.read', 'ward.manage'),
  handle(async (req, res) => res.json({ status: 'success', data: await admissions.listBeds(req.emr, req.params.wardId) })));
wardRoutes.post('/:wardId/beds', check(v.addBeds), allow('ward.manage'),
  handle(async (req, res) => res.status(201).json({ status: 'success', data: { items: await admissions.addBeds(req.emr, req.params.wardId, req.body) } })));

export const bedRoutes = express.Router({ mergeParams: true });
bedRoutes.post('/:bedId/status', check(v.bedStatus), allow('bed.manage'),
  handle(async (req, res) => send(res, await admissions.setBedStatus(req.emr, req.params.bedId, requireVersion(req), req.body))));

export const encounterAdmissionRoutes = express.Router({ mergeParams: true });
encounterAdmissionRoutes.post('/', check(v.admit), allow('admission.create'),
  handle(async (req, res) => sendResult(res, await admissions.admit(req.emr, req.params.encounterId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));

export const admissionRoutes = express.Router({ mergeParams: true });
admissionRoutes.get('/', check(v.listAdmissions), allow('admission.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await admissions.listAdmissions(req.emr, req.query) })));
admissionRoutes.get('/:admissionId', check(v.oneAdmission), allow('admission.read'),
  handle(async (req, res) => send(res, await admissions.getAdmission(req.emr, req.params.admissionId))));
admissionRoutes.post('/:admissionId/transfer', check(v.transfer), allow('admission.transfer'),
  handle(async (req, res) => send(res, await admissions.transfer(req.emr, req.params.admissionId, requireVersion(req), req.body))));
admissionRoutes.post('/:admissionId/discharge', check(v.discharge), allow('admission.discharge'),
  handle(async (req, res) => send(res, await admissions.discharge(req.emr, req.params.admissionId, requireVersion(req), req.body))));
admissionRoutes.post('/:admissionId/cancel', check(v.cancelAdmission), allow('admission.create'),
  handle(async (req, res) => send(res, await admissions.cancelAdmission(req.emr, req.params.admissionId, requireVersion(req), req.body))));

admissionRoutes.get('/:admissionId/mar', check(v.oneAdmission), allow('medication.administer', 'clinical.read', 'prescription.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await mar.marView(req.emr, req.params.admissionId) })));
admissionRoutes.post('/:admissionId/mar', check(v.recordAdministration), allow('medication.administer'),
  handle(async (req, res) => sendResult(res, await mar.recordAdministration(req.emr, req.params.admissionId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
admissionRoutes.post('/:admissionId/mar/:administrationId/entered-in-error', check(v.markAdministration), allow('medication.administer'),
  handle(async (req, res) => send(res, await mar.markAdministrationError(req.emr, req.params.admissionId, req.params.administrationId, req.body))));
