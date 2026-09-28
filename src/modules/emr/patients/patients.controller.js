import { etagFor, requireVersion } from '../core/concurrency.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as service from './patients.service.js';

const sendPatient = (res, patient, status = 200) =>
  res.status(status).set('ETag', etagFor(patient.version)).json({ status: 'success', data: patient });

export const list = async (req, res) => {
  const result = await service.listPatients(req.emr, req.query);
  res.json({ status: 'success', data: result });
};

export const register = async (req, res) => {
  const result = await service.registerPatient(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) });
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  if (result.body?.version) res.set('ETag', etagFor(result.body.version));
  res.status(result.statusCode).json({ status: 'success', data: result.body });
};

export const get = async (req, res) => sendPatient(res, await service.getPatient(req.emr, req.params.patientId));

export const update = async (req, res) =>
  sendPatient(res, await service.updatePatient(req.emr, req.params.patientId, requireVersion(req), req.body));

export const deactivate = async (req, res) =>
  sendPatient(res, await service.deactivatePatient(req.emr, req.params.patientId, requireVersion(req), req.body));

export const reactivate = async (req, res) =>
  sendPatient(res, await service.reactivatePatient(req.emr, req.params.patientId, requireVersion(req)));

export const linkAccount = async (req, res) =>
  sendPatient(res, await service.linkPatientAccount(req.emr, req.params.patientId, requireVersion(req), req.body));

export const duplicates = async (req, res) =>
  res.json({ status: 'success', data: { items: await service.findDuplicates(req.emr, req.query) } });
