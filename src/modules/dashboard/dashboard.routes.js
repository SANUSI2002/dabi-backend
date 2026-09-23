import express from 'express';
import { getDashboard, getRecordsStats } from './dashboard.controller.js';
import { protect } from '../../middleware/authMiddleware.js';

const router = express.Router();
router.use(protect);
router.get('/', getDashboard);
router.get('/records-stats', getRecordsStats);

// Keep database failures scoped to this bucket and never disclose internals.
router.use((err, req, res, next) => {
  res.status(500).json({ status: 'error', message: 'Dashboard module temporarily unavailable' });
});

export default router;
