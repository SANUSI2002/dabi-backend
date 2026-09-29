import { requireVersion } from '../core/concurrency.js';
import { send, sendItems, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as service from './encounters.service.js';

export const list = async (req, res) => res.json({ status: 'success', data: await service.listEncounters(req.emr, req.query) });

export const open = async (req, res) => {
  const result = await service.openEncounter(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) });
  sendResult(res, result);
};

export const get = async (req, res) => send(res, await service.getEncounter(req.emr, req.params.encounterId));
export const update = async (req, res) => send(res, await service.updateEncounter(req.emr, req.params.encounterId, requireVersion(req), req.body));
export const transition = (action) => async (req, res) =>
  send(res, await service.transitionEncounter(req.emr, req.params.encounterId, requireVersion(req), action, req.body));

export const listNotes = async (req, res) => sendItems(res, await service.listNotes(req.emr, req.params.encounterId));
export const createNote = async (req, res) => send(res, await service.createNote(req.emr, req.params.encounterId, req.body), 201);
export const updateNote = async (req, res) =>
  send(res, await service.updateNote(req.emr, req.params.encounterId, req.params.noteId, requireVersion(req), req.body));
export const signNote = async (req, res) =>
  send(res, await service.signNote(req.emr, req.params.encounterId, req.params.noteId, requireVersion(req)));
export const amendNote = async (req, res) =>
  send(res, await service.amendNote(req.emr, req.params.encounterId, req.params.noteId, req.body), 201);

export const listVitals = async (req, res) => sendItems(res, await service.listVitals(req.emr, req.params.encounterId));
export const recordVitals = async (req, res) =>
  res.status(201).json({ status: 'success', data: { items: await service.recordVitals(req.emr, req.params.encounterId, req.body) } });
export const markVital = async (req, res) =>
  send(res, await service.markVitalError(req.emr, req.params.encounterId, req.params.observationId, req.body));

export const listDiagnoses = async (req, res) => sendItems(res, await service.listDiagnoses(req.emr, req.params.encounterId));
export const recordDiagnosis = async (req, res) => send(res, await service.recordDiagnosis(req.emr, req.params.encounterId, req.body), 201);
export const markDiagnosis = async (req, res) =>
  send(res, await service.markDiagnosisError(req.emr, req.params.encounterId, req.params.diagnosisId, req.body));
