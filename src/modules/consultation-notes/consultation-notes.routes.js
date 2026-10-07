import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { consultationNotesService as S } from './consultation-notes.service.js';
import * as V from './consultation-notes.policy.js';

const router = express.Router();
// Clinical content: never cached. Known failures carry a stable code; P2002/P2034 mean another
// request won a race (a second tab creating the same note, or a serializable conflict).
const wrap = (work) => async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ status: 'success', data: await work(req) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ status: 'error', code: error.code, message: error.message, ...(error.problems ? { problems: error.problems } : {}) });
    if (error.code === 'P2002' || error.code === 'P2034') return res.status(409).json({ status: 'error', code: 'STALE', message: 'This note changed at the same time somewhere else. Refresh and try again.' });
    if (error instanceof z.ZodError) return res.status(400).json({ status: 'error', code: 'INVALID', message: 'Invalid consultation note.', errors: error.issues });
    return next(error);
  }
};

router.use(protect, createLimiter({ kind: 'consultation-notes', max: 120 }));

// ---------------- Doctor ----------------
router.get('/practice', validate(V.practiceListSchema), wrap((r) => S.practiceList(r.user.id, r.query)));
router.get('/practice/appointments/:appointmentId', validate(V.appointmentParams), wrap((r) => S.detail(r.user.id, r.params.appointmentId)));
router.put('/practice/appointments/:appointmentId', validate(V.appointmentParams), validate(V.saveSchema), wrap((r) => S.save(r.user.id, r.params.appointmentId, r.body)));
router.post('/practice/appointments/:appointmentId/sign', validate(V.appointmentParams), validate(V.signSchema), wrap((r) => S.sign(r.user.id, r.params.appointmentId, r.body)));

// ---------------- Patient (signed visit summaries only) ----------------
router.get('/mine', wrap((r) => S.patientList(r.user.id)));
router.get('/mine/:appointmentId', validate(V.appointmentParams), wrap((r) => S.patientOne(r.user.id, r.params.appointmentId)));

export default router;
