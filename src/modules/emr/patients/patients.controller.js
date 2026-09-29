import { requireVersion } from '../core/concurrency.js';
import { send, sendItems, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as service from './patients.service.js';

export const list = async (req, res) => {
  const result = await service.listPatients(req.emr, req.query);
  res.json({ status: 'success', data: result });
};

export const register = async (req, res) => {
  sendResult(res, await service.registerPatient(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }));
};

export const get = async (req, res) => send(res, await service.getPatient(req.emr, req.params.patientId));

export const update = async (req, res) =>
  send(res, await service.updatePatient(req.emr, req.params.patientId, requireVersion(req), req.body));

export const deactivate = async (req, res) =>
  send(res, await service.deactivatePatient(req.emr, req.params.patientId, requireVersion(req), req.body));

export const reactivate = async (req, res) =>
  send(res, await service.reactivatePatient(req.emr, req.params.patientId, requireVersion(req)));

export const linkAccount = async (req, res) =>
  send(res, await service.linkPatientAccount(req.emr, req.params.patientId, requireVersion(req), req.body));

export const duplicatePairs = async (req, res) =>
  sendItems(res, await service.duplicatePairs(req.emr, req.query));

export const duplicates = async (req, res) =>
  sendItems(res, await service.findDuplicates(req.emr, req.query));
