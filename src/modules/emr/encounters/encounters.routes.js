// /api/v1/emr/organizations/:organizationId/encounters
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (see migration 20260929090000_emr_encounters):
//   reception: check in, see the visit list — no clinical content
//   nurse:     + start/finish visits, vitals, nursing notes (write + sign)
//   doctor:    + all notes (write, sign, amend) and diagnoses
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import * as v from './encounters.validator.js';
import * as c from './encounters.controller.js';

const router = express.Router({ mergeParams: true });
const signer = allow('clinical.note.sign', 'nursing.note.sign'); // kind-specific rule in the service

router.get('/', check(v.listEncounters), allow('encounter.read'), handle(c.list));
router.post('/', check(v.openEncounter), allow('encounter.create'), handle(c.open));
router.get('/:encounterId', check(v.oneEncounter), allow('encounter.read'), handle(c.get));
router.patch('/:encounterId', check(v.updateEncounter), allow('encounter.update'), handle(c.update));
router.post('/:encounterId/start', check(v.transition), allow('encounter.update'), handle(c.transition('start')));
router.post('/:encounterId/finish', check(v.transition), allow('encounter.update'), handle(c.transition('finish')));
router.post('/:encounterId/cancel', check(v.cancelEncounter), allow('encounter.update'), handle(c.transition('cancel')));

router.get('/:encounterId/notes', check(v.oneEncounter), allow('clinical.read'), handle(c.listNotes));
router.post('/:encounterId/notes', check(v.createNote), allow('clinical.note.write'), handle(c.createNote));
router.patch('/:encounterId/notes/:noteId', check(v.updateNote), allow('clinical.note.write'), handle(c.updateNote));
router.post('/:encounterId/notes/:noteId/sign', check(v.signNote), signer, handle(c.signNote));
router.post('/:encounterId/notes/:noteId/amendments', check(v.amendNote), signer, handle(c.amendNote));

router.get('/:encounterId/vitals', check(v.oneEncounter), allow('clinical.read'), handle(c.listVitals));
router.post('/:encounterId/vitals', check(v.recordVitals), allow('vitals.record'), handle(c.recordVitals));
router.post('/:encounterId/vitals/:observationId/entered-in-error', check(v.markObservation), allow('vitals.record'), handle(c.markVital));

router.get('/:encounterId/diagnoses', check(v.oneEncounter), allow('clinical.read'), handle(c.listDiagnoses));
router.post('/:encounterId/diagnoses', check(v.recordDiagnosis), allow('diagnosis.record'), handle(c.recordDiagnosis));
router.post('/:encounterId/diagnoses/:diagnosisId/entered-in-error', check(v.markDiagnosis), allow('diagnosis.record'), handle(c.markDiagnosis));

export default router;
