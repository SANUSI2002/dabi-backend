// Linking a patient's WhatsApp number, and their notification preferences.
//
// Enabling: the patient confirms a number and agrees to WhatsApp notifications → Sabi sends a 6-digit
// code with the approved authentication template → the patient types it into Sabi → the connection
// becomes ACTIVE and the consent version and time are recorded.
// Changing the number runs the same steps; the old number keeps working until the new one is
// verified, then it is revoked in the same transaction. Turning WhatsApp off revokes the number and
// cancels anything still waiting to be sent.
import { Buffer } from 'node:buffer';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import prisma from '../../config/db.js';
import { recordAudit } from '../audit/audit.service.js';
import { WHATSAPP_CATEGORIES } from '../notifications/notify.service.js';
import { DEFAULT_TIMEZONE } from '../medication-schedules/schedule.time.js';
import { maskPhone, normalizePhone, verificationMessage } from './whatsapp.messages.js';
import { whatsappProvider } from './whatsapp.provider.js';

export const WHATSAPP_CONSENT_VERSION = 'whatsapp-notifications-v1';
const CODE_TTL_MS = 10 * 60_000;
const RESEND_AFTER_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

const fail = (status, code, message, extra = {}) => { throw Object.assign(new Error(message), { status, code, ...extra }); };
const codeSecret = () => process.env.WHATSAPP_CODE_SECRET || process.env.JWT_SECRET || '';
const hashCode = (connectionId, code) => createHmac('sha256', codeSecret()).update(`${connectionId}:${code}`).digest('hex');
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

const preferenceView = (p) => ({
  whatsappEnabled: Boolean(p?.whatsappEnabled),
  whatsappCategories: p?.whatsappCategories ?? ['MEDICATION'],
  showMedicationDetails: Boolean(p?.showMedicationDetails),
  timezone: p?.timezone ?? DEFAULT_TIMEZONE,
  consentVersion: p?.consentVersion ?? null,
  consentedAt: p?.consentedAt ?? null,
});

export async function settingsFor(userId, now = new Date()) {
  const [preference, connections, user] = await Promise.all([
    prisma.notificationPreference.findUnique({ where: { userId } }),
    prisma.whatsAppConnection.findMany({ where: { userId, status: { in: ['ACTIVE', 'PENDING'] } } }),
    prisma.user.findUnique({ where: { id: userId }, select: { phone_number: true } }),
  ]);
  const active = connections.find((c) => c.status === 'ACTIVE');
  const pending = connections.find((c) => c.status === 'PENDING');
  return {
    preferences: preferenceView(preference),
    categories: WHATSAPP_CATEGORIES,
    consentVersion: WHATSAPP_CONSENT_VERSION,
    whatsapp: {
      available: Boolean(whatsappProvider()),
      registeredPhone: normalizePhone(user?.phone_number),
      connection: active ? { phone: maskPhone(active.phone), verifiedAt: active.verifiedAt } : null,
      pending: pending ? {
        phone: maskPhone(pending.phone), expiresAt: pending.codeExpiresAt,
        resendAvailableAt: new Date(Math.max(now.getTime(), pending.codeSentAt.getTime() + RESEND_AFTER_MS)),
        attemptsLeft: Math.max(0, MAX_ATTEMPTS - pending.codeAttempts),
      } : null,
    },
  };
}

export async function updatePreferences(userId, input) {
  const data = {
    ...(input.whatsappCategories ? { whatsappCategories: [...new Set(input.whatsappCategories)] } : {}),
    ...(input.showMedicationDetails !== undefined ? { showMedicationDetails: input.showMedicationDetails } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
  };
  await prisma.$transaction(async (tx) => {
    await tx.notificationPreference.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    await recordAudit(tx, { actorUserId: userId, action: 'NOTIFICATION_SETTINGS_CHANGED' });
  });
  return settingsFor(userId);
}

async function codesSentRecently(userId, now) {
  const recent = await prisma.whatsAppConnection.aggregate({ where: { userId, createdAt: { gte: new Date(now.getTime() - 3_600_000) } }, _sum: { codesSent: true } });
  return recent._sum.codesSent ?? 0;
}

async function sendCode(connectionId, phone, code) {
  const provider = whatsappProvider();
  try {
    await provider.sendTemplate(phone, verificationMessage(code));
  } catch {
    await prisma.whatsAppConnection.updateMany({ where: { id: connectionId, status: 'PENDING' }, data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'SEND_FAILED', codeHash: null } });
    fail(502, 'CODE_NOT_SENT', 'We could not send a code to that number on WhatsApp. Check the number and try again.');
  }
}

/** Step 1: send a code to the number the patient entered. */
export async function startLinking(userId, { phone: input, consent }, now = new Date()) {
  if (consent !== true) fail(400, 'CONSENT_REQUIRED', 'Agree to receive notifications on WhatsApp to continue.');
  if (!whatsappProvider()) fail(503, 'WHATSAPP_UNAVAILABLE', 'WhatsApp notifications are not available yet.');
  const phone = normalizePhone(input);
  if (!phone) fail(400, 'INVALID_PHONE', 'Enter a valid phone number, for example 0803 123 4567 or +234 803 123 4567.');
  const linked = await prisma.whatsAppConnection.findFirst({ where: { phone, status: 'ACTIVE' }, select: { userId: true } });
  if (linked?.userId === userId) fail(409, 'ALREADY_LINKED', 'This number is already linked to your account.');
  if (linked) fail(409, 'NUMBER_IN_USE', 'This number is linked to another Sabi account.');
  if (await codesSentRecently(userId, now) >= MAX_CODES_PER_HOUR) fail(429, 'TOO_MANY_CODES', 'Too many codes requested. Try again in an hour.');
  const code = newCode();
  const connection = await prisma.$transaction(async (tx) => {
    await tx.whatsAppConnection.updateMany({ where: { userId, status: 'PENDING' }, data: { status: 'REVOKED', revokedAt: now, revokedReason: 'REPLACED', codeHash: null } });
    const created = await tx.whatsAppConnection.create({ data: { userId, phone, status: 'PENDING', codesSent: 1, codeSentAt: now, codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS) } });
    return tx.whatsAppConnection.update({ where: { id: created.id }, data: { codeHash: hashCode(created.id, code) } });
  });
  await sendCode(connection.id, phone, code);
  return settingsFor(userId, now);
}

export async function resendCode(userId, now = new Date()) {
  const pending = await prisma.whatsAppConnection.findFirst({ where: { userId, status: 'PENDING' } });
  if (!pending) fail(404, 'NO_PENDING_CODE', 'Start again by entering your WhatsApp number.');
  const wait = pending.codeSentAt.getTime() + RESEND_AFTER_MS - now.getTime();
  if (wait > 0) fail(429, 'RESEND_TOO_SOON', `You can ask for a new code in ${Math.ceil(wait / 1000)} seconds.`, { retryAfterSeconds: Math.ceil(wait / 1000) });
  if (await codesSentRecently(userId, now) >= MAX_CODES_PER_HOUR) fail(429, 'TOO_MANY_CODES', 'Too many codes requested. Try again in an hour.');
  const code = newCode();
  await prisma.whatsAppConnection.update({ where: { id: pending.id }, data: {
    codeHash: hashCode(pending.id, code), codeAttempts: 0, codesSent: { increment: 1 }, codeSentAt: now, codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS),
  } });
  await sendCode(pending.id, pending.phone, code);
  return settingsFor(userId, now);
}

/** Step 2: the patient types the code; the number becomes their WhatsApp number. */
export async function verifyCode(userId, { code }, now = new Date()) {
  const result = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`SELECT "id" FROM "whatsapp_connections" WHERE "user_id" = ${userId} AND "status" = 'PENDING' FOR UPDATE`;
    if (!row) fail(404, 'NO_PENDING_CODE', 'Start again by entering your WhatsApp number.');
    const pending = await tx.whatsAppConnection.findUnique({ where: { id: row.id } });
    if (pending.codeExpiresAt <= now) return { error: [410, 'CODE_EXPIRED', 'This code has expired. Ask for a new one.'] };
    if (pending.codeAttempts >= MAX_ATTEMPTS) return { error: [429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask for a new one.'] };
    const expected = Buffer.from(pending.codeHash ?? '', 'hex');
    const given = Buffer.from(hashCode(pending.id, String(code)), 'hex');
    if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      const attempts = pending.codeAttempts + 1;
      await tx.whatsAppConnection.update({ where: { id: pending.id }, data: { codeAttempts: attempts } });
      return { error: [400, 'WRONG_CODE', attempts >= MAX_ATTEMPTS ? 'That code is not right. Ask for a new one.' : 'That code is not right. Check the message and try again.', { attemptsLeft: MAX_ATTEMPTS - attempts }] };
    }
    if (await tx.whatsAppConnection.findFirst({ where: { phone: pending.phone, status: 'ACTIVE', userId: { not: userId } }, select: { id: true } })) {
      return { error: [409, 'NUMBER_IN_USE', 'This number is linked to another Sabi account.'] };
    }
    const previous = await tx.whatsAppConnection.findFirst({ where: { userId, status: 'ACTIVE' } });
    if (previous) await tx.whatsAppConnection.update({ where: { id: previous.id }, data: { status: 'REVOKED', revokedAt: now, revokedReason: 'NUMBER_CHANGED' } });
    await tx.whatsAppConnection.update({ where: { id: pending.id }, data: { status: 'ACTIVE', verifiedAt: now, codeHash: null } });
    const consent = { whatsappEnabled: true, consentVersion: WHATSAPP_CONSENT_VERSION, consentedAt: now };
    await tx.notificationPreference.upsert({ where: { userId }, create: { userId, ...consent }, update: consent });
    await recordAudit(tx, { actorUserId: userId, action: previous ? 'WHATSAPP_NUMBER_CHANGED' : 'WHATSAPP_ENABLED', resourceType: 'whatsapp_connection', resourceId: pending.id });
    return {};
  });
  // Wrong-code attempts are counted even though the request fails, so the error is raised after commit.
  if (result.error) fail(...result.error);
  return settingsFor(userId, now);
}

/** Turns WhatsApp off: the number is unlinked and nothing more is sent to it. */
export async function disableWhatsApp(userId, now = new Date()) {
  await prisma.$transaction(async (tx) => {
    const revoked = await tx.whatsAppConnection.updateMany({ where: { userId, status: { in: ['ACTIVE', 'PENDING'] } }, data: { status: 'REVOKED', revokedAt: now, revokedReason: 'DISABLED', codeHash: null } });
    await tx.notificationPreference.upsert({ where: { userId }, create: { userId, whatsappEnabled: false }, update: { whatsappEnabled: false } });
    await tx.notificationDelivery.updateMany({ where: { userId, channel: 'WHATSAPP', status: 'PENDING' }, data: { status: 'CANCELLED', lastError: 'WhatsApp turned off' } });
    if (revoked.count) await recordAudit(tx, { actorUserId: userId, action: 'WHATSAPP_DISABLED' });
  });
  return settingsFor(userId, now);
}
