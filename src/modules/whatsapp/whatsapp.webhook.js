// Meta's webhook: delivery status updates and patients' replies.
//
// - The signature (X-Hub-Signature-256, HMAC of the raw body with the app secret) is checked before
//   anything is read. Unsigned or wrongly signed requests are refused.
// - Every message id and status update is recorded once; a webhook Meta sends again is ignored.
// - Who the patient is comes from the verified connection, never from the message text: a button
//   works only if it was sent to the number that is linked now, and only for that patient's dose.
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import prisma from '../../config/db.js';
import { clockLabel, localClock } from '../medication-schedules/schedule.time.js';
import { recordDose, snoozeReminder } from '../medication-schedules/schedule.service.js';
import { REPLIES, parsePayload } from './whatsapp.messages.js';
import { whatsappConfig, whatsappProvider } from './whatsapp.provider.js';

export function signatureValid(rawBody, header, secret = whatsappConfig().appSecret) {
  if (!secret || !Buffer.isBuffer(rawBody) || !/^sha256=[0-9a-f]{64}$/i.test(String(header || ''))) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const given = Buffer.from(String(header).slice(7), 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** True the first time an event id is seen. */
async function firstTime(id, kind) {
  const { count } = await prisma.whatsAppWebhookEvent.createMany({ data: [{ id: String(id).slice(0, 200), kind }], skipDuplicates: true });
  return count === 1;
}

const RANK = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };
const STATUS = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };

async function applyStatus(update) {
  const next = STATUS[update?.status];
  if (!update?.id || !next || !(await firstTime(`${update.id}:${update.status}`, 'status'))) return;
  const delivery = await prisma.notificationDelivery.findUnique({ where: { providerMessageId: String(update.id) } });
  if (!delivery || !(delivery.status in RANK)) return;
  if (next === 'FAILED') {
    // A late "failed" never overrides a message the phone already received.
    if (RANK[delivery.status] < RANK.DELIVERED) {
      const reason = update.errors?.[0];
      await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', lastError: `WhatsApp could not deliver (${reason?.code ?? 'unknown'})` } });
    }
    return;
  }
  if (RANK[next] <= RANK[delivery.status]) return;
  const at = update.timestamp ? new Date(Number(update.timestamp) * 1000) : new Date();
  await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: {
    status: next, ...(next === 'DELIVERED' ? { deliveredAt: at } : {}), ...(next === 'READ' ? { readAt: at, deliveredAt: delivery.deliveredAt ?? at } : {}),
  } });
}

async function reply(to, text) {
  try { await whatsappProvider()?.sendText(to, text); } catch { /* a reply that fails to send changes nothing */ }
}

const buttonPayloadOf = (message) => message.button?.payload ?? message.interactive?.button_reply?.id ?? null;

async function handleMessage(message) {
  if (!message?.id || !message.from || !(await firstTime(message.id, 'message'))) return;
  const from = `+${String(message.from).replace(/\D/g, '')}`;
  const linked = await prisma.whatsAppConnection.findFirst({ where: { phone: from, status: 'ACTIVE' } });
  const parsed = parsePayload(buttonPayloadOf(message));
  if (!parsed) {
    if (linked) await reply(from, REPLIES.help);
    return;
  }
  // The button must have been sent to this number while it was the patient's linked number.
  if (!linked || linked.id !== parsed.connectionId) return reply(from, REPLIES.inactive);
  const job = await prisma.reminderJob.findUnique({ where: { id: parsed.jobId }, include: { dose: { include: { schedule: true } } } });
  if (!job || job.userId !== linked.userId) return reply(from, REPLIES.inactive);
  const { timezone } = job.dose.schedule;

  if (parsed.action === 'TAKEN') {
    try {
      const result = await recordDose(linked.userId, job.doseId, 'TAKEN', { via: 'WHATSAPP' });
      return reply(from, result.alreadyRecorded ? REPLIES.alreadyRecorded : REPLIES.recorded(clockLabel(localClock(new Date(), timezone))));
    } catch (error) {
      if (error.code === 'DOSE_CANCELLED' || error.code === 'TOO_EARLY' || error.code === 'NOT_FOUND') return reply(from, REPLIES.doseClosed);
      throw error;
    }
  }
  const snoozed = await snoozeReminder(linked.userId, job.id);
  const text = {
    SNOOZED: () => REPLIES.snoozed(clockLabel(snoozed.at)),
    LIMIT: () => REPLIES.snoozeLimit,
    ALREADY_RECORDED: () => REPLIES.alreadyRecorded,
    CLOSED: () => REPLIES.doseClosed,
  }[snoozed.outcome]();
  return reply(from, text);
}

/**
 * Applies one verified webhook body. Items are handled one by one so a bad item cannot block the
 * rest. A failed item is forgotten again and counted, so the caller answers 500 and Meta retries it;
 * items already handled are skipped on the retry. (Recording a dose and snoozing are idempotent too.)
 */
export async function handleWebhook(body) {
  let failed = 0;
  const attempt = async (work, eventId, label) => {
    try { await work(); } catch (error) {
      failed += 1;
      console.error(`[whatsapp] ${label} failed`, error?.code ?? error?.name);
      if (eventId) await prisma.whatsAppWebhookEvent.deleteMany({ where: { id: String(eventId).slice(0, 200) } }).catch(() => {});
    }
  };
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      for (const update of value.statuses ?? []) await attempt(() => applyStatus(update), update?.id && `${update.id}:${update.status}`, 'status update');
      for (const message of value.messages ?? []) await attempt(() => handleMessage(message), message?.id, 'reply handling');
    }
  }
  return { failed };
}
