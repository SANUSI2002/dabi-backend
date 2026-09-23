import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import * as controller from './prescriptions.controller.js';
import * as validator from './prescriptions.validator.js';

const router = express.Router();
router.use(protect);
router.get('/patient', validate(validator.list), controller.patientList);
router.get('/issued', validate(validator.list), controller.doctorList);
router.post('/', validate(validator.createDraft), controller.createDraft);
router.put('/:id', validate(validator.updateDraft), controller.updateDraft);
router.post('/:id/issue', validate(validator.transition), controller.issue);
router.delete('/:id', validate(validator.transition), controller.cancel);
router.get('/:id', validate(validator.prescriptionId), controller.read);
router.use((error, req, res, next) => res.status(500).json({ status: 'error', message: 'Prescription module temporarily unavailable' }));
export default router;
