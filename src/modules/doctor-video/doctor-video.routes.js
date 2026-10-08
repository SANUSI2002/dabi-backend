import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { CONSENT_VERSIONS, videoService } from './doctor-video.service.js';
const params = z.object({ id: z.uuid() }).strict();
const query = z.object({}).strict();
const join = z.object({ params, query, body: z.object({ providerConsent: z.literal(true), consentVersion: z.enum(Object.values(CONSENT_VERSIONS)).optional() }).strict() });
const status = z.object({ params, query });
const messages = {
  VIDEO_NOT_FOUND: 'Consultation not found.', VIDEO_ACCESS_DENIED: 'Only the assigned verified doctor and patient can join.',
  VIDEO_APPOINTMENT_NOT_READY: 'This must be a confirmed video appointment.', VIDEO_TOO_EARLY: 'The call opens 10 minutes before the appointment.',
  VIDEO_WINDOW_ENDED: 'The consultation window has ended.', VIDEO_CONSENT_REQUIRED: 'Please confirm the video privacy notice.',
  VIDEO_UNAVAILABLE: 'Video calls are not enabled yet. Please contact Sabi support.', VIDEO_PROVIDER_LIMIT: 'The video provider has reached a limit. Please try again later.',
};
const safe = (work) => async (req, res, next) => { try { res.set('Cache-Control', 'no-store').json({ status: 'success', data: await work(req) }); } catch (error) {
  if (!error.status) return next(error);
  return res.status(error.status).set('Cache-Control', 'no-store').json({ status: 'error', code: error.code, message: messages[error.code] || 'Video service temporarily unavailable. Please retry.' });
} };
export const videoConfigRoutes = express.Router();
videoConfigRoutes.get('/video-config', safe(() => videoService.config()));
export const videoPatientRoutes = express.Router();
export const videoDoctorRoutes = express.Router();
for (const [router, role] of [[videoPatientRoutes, 'patient'], [videoDoctorRoutes, 'doctor']]) {
  router.get('/:id/video-session', protect, validate(status), safe((q) => videoService.check(q.user.id, q.params.id, role)));
  router.post('/:id/video-session', protect, createLimiter({ kind: `video-join-${role}`, max: 20, keyGenerator: (q) => `video:${role}:${q.user.id}` }), validate(join), safe((q) => videoService.join(q.user.id, q.params.id, role, q.body)));
}
