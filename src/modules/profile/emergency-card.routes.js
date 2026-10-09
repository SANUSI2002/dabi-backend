import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { accountOrIpKey, createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { recordAudit } from '../audit/audit.service.js';
import prisma from '../../config/db.js';
import { emergencyCardService as service, DENIED_MESSAGE, EMERGENCY_CONSENT_VERSION } from './emergency-card.service.js';

const router = express.Router();
router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  // Failed auth/rate-limited lookups are recorded too, without the supplied code or a target identity.
  res.on('finish', () => {
    if (req.path === '/lookup' && res.statusCode >= 400 && !req.auditRecorded) {
      recordAudit(prisma, { actorUserId: req.user?.id || 'anonymous', action: 'EMERGENCY_ACCESS_DENIED', context: { outcome: 'DENIED', status: res.statusCode } }, { req })
        .catch(() => console.error('[emergency-card] denied-access audit unavailable'));
    }
  });
  next();
});
const lookupIpLimiter = createLimiter({ kind: 'emergency-ip', max: 100 });
const lookupAccountLimiter = createLimiter({ kind: 'emergency-lookup', max: 12, windowMs: 60_000, keyGenerator: accountOrIpKey });
router.post('/lookup', lookupIpLimiter, protect, lookupAccountLimiter, async (req, res) => {
  try {
    const parsed = z.object({ code: z.string().max(80), hospitalId: z.string().uuid().optional(), reason: z.string().trim().max(300).optional() }).strict().safeParse(req.body);
    if (!parsed.success) {
      await recordAudit(prisma, { actorUserId: req.user.id, action: 'EMERGENCY_ACCESS_DENIED', context: { outcome: 'DENIED' } }, { req });
      return res.status(403).json({ status: 'error', code: 'EMERGENCY_ACCESS_DENIED', message: DENIED_MESSAGE });
    }
    const data = await service.lookup(req.user.id, parsed.data, req);
    if (data.denied) return res.status(403).json({ status: 'error', code: 'EMERGENCY_ACCESS_DENIED', message: DENIED_MESSAGE });
    return res.json({ status: 'success', data });
  } catch {
    req.auditRecorded = false; // A rolled-back transaction has no durable audit; finish handler retries.
    // Prisma errors can include parameters. Never send or log their code/health-data contents.
    return res.status(503).json({ status: 'error', code: 'EMERGENCY_UNAVAILABLE', message: 'Emergency information is temporarily unavailable. Please retry.' });
  }
});
router.use(protect);
const endpoint = (work) => async (req, res) => {
  try { return res.json({ status: 'success', data: await work(req) }); }
  catch (error) {
    if (error.status) return res.status(error.status).json({ status: 'error', code: error.code, message: error.message });
    if (['P2002', 'P2034'].includes(error.code)) return res.status(409).json({ status: 'error', code: 'CARD_CHANGED', message: 'Your card changed. Refresh and try again.' });
    return res.status(503).json({ status: 'error', message: 'Your Emergency Card is temporarily unavailable. Please retry.' });
  }
};
const updateSchema = z.object({ body: z.object({
  version: z.number().int().positive(), displayName: z.string().trim().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}<>]*$/u).optional(),
  sharingEnabled: z.boolean().optional(), notificationEnabled: z.boolean().optional(),
  scopes: z.object({ careCircle: z.boolean(), hospitals: z.boolean() }).strict().optional(),
  consentVersion: z.literal(EMERGENCY_CONSENT_VERSION).optional(),
}).strict() });
router.get('/responder', endpoint((req) => service.responderContext(req.user.id)));
router.get('/', endpoint((req) => service.getCard(req.user.id)));
router.put('/', validate(updateSchema), endpoint((req) => service.saveCard(req.user.id, req.body)));
router.post('/replace-code', validate(z.object({ body: z.object({ version: z.number().int().positive(), confirmation: z.literal('REPLACE') }).strict() })), endpoint((req) => service.replaceCode(req.user.id, req.body)));
export default router;
