// Settings → Notifications: which updates go to WhatsApp, the linked number, and consent.
import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { accountOrIpKey, createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { isTimeZone } from '../medication-schedules/schedule.time.js';
import * as W from '../whatsapp/whatsapp.connection.js';
import { WHATSAPP_CATEGORIES } from './notify.service.js';

export const respond = (work) => async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ status: 'success', data: await work(req) });
  } catch (error) {
    if (error.status) {
      const { status, code, message, attemptsLeft, retryAfterSeconds } = error;
      return res.status(status).json({ status: 'error', code, message, ...(attemptsLeft !== undefined ? { attemptsLeft } : {}), ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
    }
    if (error.code === 'P2002' || error.code === 'P2034') return res.status(409).json({ status: 'error', code: 'CONFLICT', message: 'This changed at the same time somewhere else. Refresh and try again.' });
    return next(error);
  }
};

const preferencesSchema = z.object({ body: z.object({
  whatsappCategories: z.array(z.enum(WHATSAPP_CATEGORIES)).max(WHATSAPP_CATEGORIES.length).optional(),
  showMedicationDetails: z.boolean().optional(),
  timezone: z.string().max(64).refine(isTimeZone, 'Unknown time zone').optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Nothing to change') });
const startSchema = z.object({ body: z.object({ phone: z.string().trim().min(6).max(24), consent: z.literal(true) }).strict() });
const verifySchema = z.object({ body: z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict() });

const router = express.Router();
router.use(protect);
// Codes cost money and reach a phone: a tight per-account budget on top of the hourly limit in the service.
const codeLimiter = createLimiter({ kind: 'whatsapp-code', max: 20, keyGenerator: (req) => `whatsapp-code:${accountOrIpKey(req)}` });

router.get('/', respond((req) => W.settingsFor(req.user.id)));
router.put('/', validate(preferencesSchema), respond((req) => W.updatePreferences(req.user.id, req.body)));
router.post('/whatsapp', codeLimiter, validate(startSchema), respond((req) => W.startLinking(req.user.id, req.body)));
router.post('/whatsapp/resend', codeLimiter, respond((req) => W.resendCode(req.user.id)));
router.post('/whatsapp/verify', codeLimiter, validate(verifySchema), respond((req) => W.verifyCode(req.user.id, req.body)));
router.delete('/whatsapp', respond((req) => W.disableWhatsApp(req.user.id)));

export default router;
