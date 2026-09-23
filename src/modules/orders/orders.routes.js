import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import * as controller from './orders.controller.js';
import * as validator from './orders.validator.js';

const router = express.Router();
router.use(protect);
router.post('/', validate(validator.create), controller.create);
router.get('/', controller.list);
router.get('/:id', validate(validator.id), controller.detail);
router.use((error, req, res, next) => res.status(500).json({
  status: 'error',
  message: 'Orders module temporarily unavailable',
}));

export default router;
