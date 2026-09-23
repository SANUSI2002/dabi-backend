import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import * as controller from './checkout-pricing.controller.js';
import * as validator from './checkout-pricing.validator.js';

const router = express.Router();
router.use(protect);
router.get('/admin', controller.current);
router.put('/admin', validate(validator.update), controller.update);
router.post('/preview/reservations/:id', validate(validator.preview), controller.preview);
router.use((error, req, res, next) => res.status(500).json({
  status: 'error',
  message: 'Checkout pricing module temporarily unavailable',
}));

export default router;
