import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { AUDIT_CATEGORIES, auditFor } from './audit.service.js';

const router = express.Router();
const listSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(50).default(30),
    cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z_[0-9a-f-]{36}$/).optional(),
    category: z.enum(AUDIT_CATEGORIES).optional(),
  }).strict(),
});

/** The signed-in person's Activity log: what they did and what was done with their health record. */
router.get('/mine', protect, createLimiter({ kind: 'audit', max: 120 }), validate(listSchema), async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json({ status: 'success', data: await auditFor(req.user.id, req.query) });
  } catch (error) { next(error); }
});

export default router;
