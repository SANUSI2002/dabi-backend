// Phone and computer notifications (Web Push), the kind any app shows on the lock screen.
//
// - A device subscribes once the person allows notifications; its endpoint and keys are stored.
// - Messages are encrypted for that device (the push service only relays them) and signed with this
//   server's VAPID key: WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY (generate once with
//   `npx web-push generate-vapid-keys`), WEB_PUSH_SUBJECT (mailto: or https: contact).
// - A medicine reminder carries Taken / Remind me later buttons. The service worker has no sign-in, so
//   each button carries a short-lived token naming that reminder and patient, signed by this server.
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import webpush from 'web-push';
import prisma from '../../config/db.js';

const ACTION_TOKEN_TTL_MS = 12 * 3_600_000;

export const pushConfig = () => {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY || '';
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY || '';
  return { enabled: Boolean(publicKey && privateKey), publicKey, privateKey, subject: process.env.WEB_PUSH_SUBJECT || 'mailto:support@sabihealth.org' };
};

export class PushSendError extends Error {
  constructor(message, { gone = false, transient = false, status = null } = {}) {
    super(message);
    this.name = 'PushSendError';
    this.gone = gone; // the device unsubscribed or the subscription expired: forget it
    this.transient = transient;
    this.status = status;
  }
}

/** Sends one encrypted message to one device. */
export async function sendPush(subscription, payload, { ttlSeconds = 3600, urgency = 'normal' } = {}) {
  const config = pushConfig();
  if (!config.enabled) throw new PushSendError('Phone notifications are not configured', { transient: false });
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      { vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }, TTL: ttlSeconds, urgency, timeout: 15_000 },
    );
  } catch (error) {
    const status = error?.statusCode ?? null;
    throw new PushSendError(`Push service answered ${status ?? error?.code ?? 'with an error'}`, {
      status, gone: status === 404 || status === 410, transient: status === null || status === 429 || status >= 500,
    });
  }
}

const actionSecret = () => process.env.WEB_PUSH_ACTION_SECRET || process.env.JWT_SECRET || '';
const sign = (body) => createHmac('sha256', actionSecret()).update(body).digest('base64url');

/** Token for a notification button: which reminder, whose, until when. */
export function actionToken({ jobId, userId }, now = new Date()) {
  const body = Buffer.from(JSON.stringify({ j: jobId, u: userId, e: now.getTime() + ACTION_TOKEN_TTL_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** { jobId, userId } from a valid, unexpired token; null otherwise. */
export function readActionToken(token, now = new Date()) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature || !actionSecret()) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { j, u, e } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof j === 'string' && typeof u === 'string' && e > now.getTime() ? { jobId: j, userId: u } : null;
  } catch {
    return null;
  }
}

export const activeSubscriptions = (userId, db = prisma) => db.pushSubscription.findMany({ where: { userId, revokedAt: null } });

export async function subscribe(userId, { endpoint, keys, device }) {
  // An endpoint belongs to one browser profile; if another account used it, it moves to this one.
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, device: device?.slice(0, 160) ?? null },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth, device: device?.slice(0, 160) ?? null, revokedAt: null },
  });
  return { subscribed: true };
}

export async function unsubscribe(userId, endpoint) {
  await prisma.pushSubscription.updateMany({ where: { userId, endpoint, revokedAt: null }, data: { revokedAt: new Date() } });
  return { subscribed: false };
}
