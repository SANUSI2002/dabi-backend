// Phone and computer notifications: turn them on for a device, send a test, and handle the
// Taken / Remind me later buttons on a medicine reminder.
import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { accountOrIpKey, createLimiter } from '../../middleware/rateLimitMiddleware.js';
import prisma from '../../config/db.js';
import { deviceLabel } from '../audit/audit.context.js';
import { clockLabel, localClock } from '../medication-schedules/schedule.time.js';
import { recordDose, snoozeReminder } from '../medication-schedules/schedule.service.js';
import { REPLIES } from '../whatsapp/whatsapp.messages.js';
import { respond } from './notification-settings.routes.js';
import { activeSubscriptions, pushConfig, readActionToken, sendPush, subscribe, unsubscribe } from './push.service.js';

const endpoint = z.string().url().max(1000).refine((url) => url.startsWith('https://'), 'Push endpoints use https');
const subscribeSchema = z.object({ body: z.object({ endpoint, keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }) }).strip() });
const unsubscribeSchema = z.object({ body: z.object({ endpoint }).strict() });
const actionSchema = z.object({ body: z.object({ token: z.string().min(20).max(600), action: z.enum(['taken', 'snooze']) }).strict() });

const router = express.Router();

// The service worker has no sign-in: the button's signed token says which reminder and whose.
router.post('/action', createLimiter({ kind: 'push-action', max: 60 }), validate(actionSchema), respond(async (req) => {
  const claim = readActionToken(req.body.token);
  if (!claim) throw Object.assign(new Error(REPLIES.inactive), { status: 401, code: 'ACTION_EXPIRED' });
  const job = await prisma.reminderJob.findFirst({ where: { id: claim.jobId, userId: claim.userId }, include: { dose: { include: { schedule: true } } } });
  if (!job) return { message: REPLIES.doseClosed };
  const { timezone } = job.dose.schedule;
  if (req.body.action === 'taken') {
    try {
      const result = await recordDose(claim.userId, job.doseId, 'TAKEN', { via: 'PUSH' });
      return { message: result.alreadyRecorded ? REPLIES.alreadyRecorded : REPLIES.recorded(clockLabel(localClock(new Date(), timezone))) };
    } catch (error) {
      if (['DOSE_CANCELLED', 'TOO_EARLY', 'NOT_FOUND'].includes(error.code)) return { message: REPLIES.doseClosed };
      throw error;
    }
  }
  const snoozed = await snoozeReminder(claim.userId, job.id);
  return { message: { SNOOZED: () => REPLIES.snoozed(clockLabel(snoozed.at)), LIMIT: () => REPLIES.snoozeLimit, ALREADY_RECORDED: () => REPLIES.alreadyRecorded, CLOSED: () => REPLIES.doseClosed }[snoozed.outcome]() };
}));

router.use(protect);

router.get('/config', respond(async (req) => {
  const config = pushConfig();
  const devices = await activeSubscriptions(req.user.id);
  return { available: config.enabled, publicKey: config.enabled ? config.publicKey : null, devices: devices.map((d) => ({ endpoint: d.endpoint, device: d.device, since: d.createdAt, lastSuccessAt: d.lastSuccessAt })) };
}));
router.post('/subscriptions', validate(subscribeSchema), respond((req) => {
  if (!pushConfig().enabled) throw Object.assign(new Error('Phone notifications are not available yet.'), { status: 503, code: 'PUSH_UNAVAILABLE' });
  return subscribe(req.user.id, { ...req.body, device: deviceLabel(req.get('user-agent')) });
}));
router.delete('/subscriptions', validate(unsubscribeSchema), respond((req) => unsubscribe(req.user.id, req.body.endpoint)));

const testLimiter = createLimiter({ kind: 'push-test', max: 10, keyGenerator: (req) => `push-test:${accountOrIpKey(req)}` });
router.post('/test', testLimiter, respond(async (req) => {
  const devices = await activeSubscriptions(req.user.id);
  if (!devices.length) throw Object.assign(new Error('Turn on notifications on this device first.'), { status: 409, code: 'NO_DEVICE' });
  let sent = 0;
  for (const device of devices) {
    try {
      await sendPush(device, { title: 'Notifications are on', body: 'This is how Sabi reminders and updates will appear.', tag: 'sabi-test', url: '/settings/notifications' }, { ttlSeconds: 300 });
      sent += 1;
    } catch (error) {
      if (error.gone) await prisma.pushSubscription.updateMany({ where: { id: device.id }, data: { revokedAt: new Date() } });
    }
  }
  return { sent };
}));

export default router;
