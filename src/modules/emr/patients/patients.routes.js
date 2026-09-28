// /api/v1/emr/organizations/:organizationId/patients
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
import express from 'express';
import { requireEmrPermission } from '../core/context.js';
import { handle, validateEmr } from '../core/validate.js';
import * as v from './patients.validator.js';
import * as c from './patients.controller.js';

const router = express.Router({ mergeParams: true });

router.get('/', validateEmr(v.listPatients), requireEmrPermission('patient.read'), handle(c.list));
router.post('/', validateEmr(v.createPatient), requireEmrPermission('patient.register'), handle(c.register));
router.get('/duplicates', validateEmr(v.duplicateCheck), requireEmrPermission('patient.read', 'patient.register'), handle(c.duplicates));
router.get('/:patientId', validateEmr(v.getPatient), requireEmrPermission('patient.read'), handle(c.get));
router.patch('/:patientId', validateEmr(v.updatePatient), requireEmrPermission('patient.update'), handle(c.update));
router.post('/:patientId/deactivate', validateEmr(v.deactivatePatient), requireEmrPermission('patient.deactivate'), handle(c.deactivate));
router.post('/:patientId/reactivate', validateEmr(v.reactivatePatient), requireEmrPermission('patient.deactivate'), handle(c.reactivate));
router.post('/:patientId/link-account', validateEmr(v.linkAccount), requireEmrPermission('patient.update'), handle(c.linkAccount));

export default router;
