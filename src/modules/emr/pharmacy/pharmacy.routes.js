// Prescribing, pharmacy and stock routes.
//   /api/v1/emr/organizations/:organizationId/pharmacy/...                        formulary, stock, queue, dispensing
//   /api/v1/emr/organizations/:organizationId/encounters/:encounterId/prescriptions  prescribe in a visit
//   /api/v1/emr/organizations/:organizationId/patients/:patientId/allergies|medications
//
// Who can do what (migration 20261001090000_emr_pharmacy):
//   doctor:      prescribe, cancel, read prescriptions and the formulary, record allergies
//   nurse:       read prescriptions, record allergies
//   pharmacist:  review, dispense, returns, stock, formulary, record allergies
//   inventory:   stock; hospital admin: formulary
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { etagFor, requireVersion } from '../core/concurrency.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './pharmacy.validator.js';
import * as stock from './stock.service.js';
import * as prescriptions from './prescriptions.service.js';
import * as dispensing from './dispensing.service.js';
import * as allergies from './allergies.service.js';

const send = (res, data, status = 200) => {
  if (data?.version) res.set('ETag', etagFor(data.version));
  res.status(status).json({ status: 'success', data });
};
const sendResult = (res, result) => {
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  send(res, result.body, result.statusCode);
};
const items = (res, list) => res.json({ status: 'success', data: { items: list } });

// ---------------------------------------------------------------------------------------------
export const pharmacyRoutes = express.Router({ mergeParams: true });

pharmacyRoutes.get('/formulary', check(v.listFormulary), allow('emr.stock.view', 'prescription.create', 'prescription.read'),
  handle(async (req, res) => items(res, await stock.listFormulary(req.emr, req.query))));
pharmacyRoutes.post('/formulary', check(v.createFormulary), allow('emr.formulary.manage'),
  handle(async (req, res) => send(res, await stock.createFormularyItem(req.emr, req.body), 201)));
pharmacyRoutes.patch('/formulary/:code', check(v.updateFormulary), allow('emr.formulary.manage'),
  handle(async (req, res) => send(res, await stock.updateFormularyItem(req.emr, req.params.code, requireVersion(req), req.body))));

pharmacyRoutes.get('/stock', check(v.stockLevels), allow('emr.stock.view'),
  handle(async (req, res) => items(res, await stock.stockLevels(req.emr, req.query))));
// Receipts change stock: the Idempotency-Key is mandatory so a retried request cannot double it.
pharmacyRoutes.post('/stock/receipts', check(v.receive), allow('emr.stock.manage'),
  handle(async (req, res) => sendResult(res, await stock.receiveStock(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
pharmacyRoutes.post('/stock/batches/:batchId/adjust', check(v.adjust), allow('emr.stock.manage'),
  handle(async (req, res) => send(res, await stock.adjustStock(req.emr, req.params.batchId, requireVersion(req), req.body))));
pharmacyRoutes.get('/stock/movements', check(v.movements), allow('emr.stock.view'),
  handle(async (req, res) => res.json({ status: 'success', data: await stock.movements(req.emr, req.query) })));
pharmacyRoutes.get('/stock/reconciliation', check(v.orgOnly), allow('emr.stock.view'),
  handle(async (req, res) => send(res, await stock.reconciliation(req.emr))));

pharmacyRoutes.get('/prescriptions', check(v.queue), allow('prescription.review', 'prescription.dispense'),
  handle(async (req, res) => res.json({ status: 'success', data: await prescriptions.queue(req.emr, req.query) })));
pharmacyRoutes.get('/prescriptions/:prescriptionId', check(v.onePrescription), allow('prescription.read'),
  handle(async (req, res) => send(res, await prescriptions.getPrescription(req.emr, req.params.prescriptionId))));
pharmacyRoutes.post('/prescriptions/:prescriptionId/approve', check(v.approve), allow('prescription.review'),
  handle(async (req, res) => send(res, await prescriptions.review(req.emr, req.params.prescriptionId, requireVersion(req), 'approve', req.body))));
pharmacyRoutes.post('/prescriptions/:prescriptionId/reject', check(v.reject), allow('prescription.review'),
  handle(async (req, res) => send(res, await prescriptions.review(req.emr, req.params.prescriptionId, requireVersion(req), 'reject', req.body))));
pharmacyRoutes.post('/prescriptions/:prescriptionId/dispense', check(v.dispense), allow('prescription.dispense'),
  handle(async (req, res) => sendResult(res, await dispensing.dispense(req.emr, req.params.prescriptionId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
pharmacyRoutes.post('/dispenses/:dispenseId/returns', check(v.returnDispense), allow('prescription.dispense'),
  handle(async (req, res) => sendResult(res, await dispensing.returnDispense(req.emr, req.params.dispenseId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));

// ---------------------------------------------------------------------------------------------
export const encounterPrescriptionRoutes = express.Router({ mergeParams: true });

encounterPrescriptionRoutes.get('/', check(v.encounterPrescriptions), allow('prescription.read'),
  handle(async (req, res) => items(res, await prescriptions.listEncounterPrescriptions(req.emr, req.params.encounterId))));
encounterPrescriptionRoutes.post('/', check(v.prescribe), allow('prescription.create'),
  handle(async (req, res) => sendResult(res, await prescriptions.prescribe(req.emr, req.params.encounterId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
encounterPrescriptionRoutes.post('/:prescriptionId/cancel', check(v.cancelPrescription), allow('prescription.create'),
  handle(async (req, res) => send(res, await prescriptions.cancel(req.emr, req.params.encounterId, req.params.prescriptionId, requireVersion(req), req.body))));

// ---------------------------------------------------------------------------------------------
export const patientPharmacyRoutes = express.Router({ mergeParams: true });

patientPharmacyRoutes.get('/allergies', check(v.listAllergies), allow('clinical.read', 'prescription.read', 'allergy.record'),
  handle(async (req, res) => items(res, await allergies.listAllergies(req.emr, req.params.patientId, req.query))));
patientPharmacyRoutes.post('/allergies', check(v.recordAllergy), allow('allergy.record'),
  handle(async (req, res) => send(res, await allergies.recordAllergy(req.emr, req.params.patientId, req.body), 201)));
patientPharmacyRoutes.post('/allergies/:allergyId/entered-in-error', check(v.markAllergy), allow('allergy.record'),
  handle(async (req, res) => send(res, await allergies.markAllergyError(req.emr, req.params.patientId, req.params.allergyId, req.body))));
patientPharmacyRoutes.get('/medications', check(v.medications), allow('prescription.read'),
  handle(async (req, res) => items(res, await prescriptions.patientMedications(req.emr, req.params.patientId, req.query))));
