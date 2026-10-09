// Sends queued deliveries (worker step): WhatsApp messages and phone/computer notifications (Web Push).
//
// Each delivery is claimed with FOR UPDATE SKIP LOCKED and leased, so a crash mid-send is retried
// later instead of lost, and two instances never send the same row. Just before sending it re-checks
// everything that may have changed since the notification was made: that channel still wanted for
// that kind of update, a number or device still linked, and for reminders that the dose is still
// unconfirmed (or the appointment still on). Temporary failures are retried with back-off; permanent
// ones are marked FAILED. The in-app notification is never touched here.
import prisma from '../../config/db.js';
import { clockLabel, partOfDay } from '../medication-schedules/schedule.time.js';
import { ACTIONS, buttonPayload, reminderMessage, updateMessage } from '../whatsapp/whatsapp.messages.js';
import { whatsappProvider } from '../whatsapp/whatsapp.provider.js';
import { wantsPush, wantsWhatsApp } from './notify.service.js';
import { prepareAppointmentReminder } from './appointment.notices.js';
import { actionToken, activeSubscriptions, pushConfig, sendPush } from './push.service.js';

const LEASE_MS = 2 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const REMINDER_STALE_MS = 2 * 3_600_000;
const UPDATE_STALE_MS = 24 * 3_600_000;
// Events whose message has its own wording and must be re-checked just before sending.
const PREPARERS = { 'appointment.reminder': prepareAppointmentReminder };
// What a lock screen shows for an update when the patient keeps details private.
const PRIVATE_BODY = { APPOINTMENT: 'You have an appointment update. Open Sabi to see it.', CARE: 'You have a new update about your care. Open Sabi to see it.' };

async function claimDue(limit, now) {
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw`
      SELECT "id" FROM "notification_deliveries"
      WHERE "status" = 'PENDING' AND "next_attempt_at" <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "next_attempt_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (!due.length) return [];
    const ids = due.map((row) => row.id);
    await tx.notificationDelivery.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + LEASE_MS) } });
    return tx.notificationDelivery.findMany({ where: { id: { in: ids } }, include: { notification: true } });
  });
}

/** The reminder behind a delivery, if it should still go out: { job } or { skip }. */
async function reminderFor(delivery, now) {
  const job = await prisma.reminderJob.findUnique({ where: { id: delivery.reminderJobId }, include: { dose: { include: { schedule: true } } } });
  if (!job || job.dose.status !== 'NOT_CONFIRMED' || job.status === 'CANCELLED') return { skip: ['CANCELLED', 'Dose already recorded or reminder cancelled'] };
  if (now.getTime() - delivery.notification.createdAt.getTime() > REMINDER_STALE_MS) return { skip: ['SKIPPED', 'Too late to remind'] };
  return { job };
}
const medicineLabel = (preference, dose) => (preference?.showMedicationDetails
  ? `${dose.schedule.name}${dose.schedule.dosage ? ` ${dose.schedule.dosage}` : ''}`
  : `${partOfDay(dose.localTime)} medicine`);

// ---------------------------------------------------------------- WhatsApp
async function prepareWhatsApp(delivery, now) {
  const { notification } = delivery;
  const [preference, connection] = await Promise.all([
    prisma.notificationPreference.findUnique({ where: { userId: delivery.userId } }),
    prisma.whatsAppConnection.findFirst({ where: { userId: delivery.userId, status: 'ACTIVE' } }),
  ]);
  if (!wantsWhatsApp(preference, notification.category)) return { skip: ['SKIPPED', 'Patient does not want this on WhatsApp'] };
  if (!connection) return { skip: ['SKIPPED', 'No WhatsApp number linked'] };
  if (!delivery.reminderJobId) {
    if (now.getTime() - notification.createdAt.getTime() > UPDATE_STALE_MS) return { skip: ['SKIPPED', 'Too old to send'] };
    const custom = PREPARERS[notification.eventType];
    if (custom) {
      const prepared = await custom(prisma, notification, { now });
      return prepared.skip ? { skip: prepared.skip } : { connection, message: prepared.message };
    }
    return { connection, message: updateMessage(notification.title) };
  }
  const reminder = await reminderFor(delivery, now);
  if (reminder.skip) return reminder;
  const { job } = reminder;
  return {
    connection,
    message: reminderMessage({
      label: medicineLabel(preference, job.dose), time: clockLabel(job.dose.localTime),
      takenPayload: buttonPayload(ACTIONS.TAKEN, job.id, connection.id),
      snoozePayload: buttonPayload(ACTIONS.SNOOZE, job.id, connection.id),
    }),
  };
}

async function sendWhatsApp(delivery, now) {
  const provider = whatsappProvider();
  if (!provider) return { status: 'SKIPPED', lastError: 'WhatsApp is not configured' };
  const plan = await prepareWhatsApp(delivery, now);
  if (plan.skip) return { status: plan.skip[0], lastError: plan.skip[1] };
  const { messageId } = await provider.sendTemplate(plan.connection.phone, plan.message);
  return { status: 'SENT', providerMessageId: messageId, connectionId: plan.connection.id, sentAt: new Date(), lastError: null };
}

// ---------------------------------------------------------------- phone / computer notifications
async function preparePush(delivery, now) {
  const { notification } = delivery;
  const [preference, devices] = await Promise.all([
    prisma.notificationPreference.findUnique({ where: { userId: delivery.userId } }),
    activeSubscriptions(delivery.userId),
  ]);
  if (!wantsPush(preference, notification.category)) return { skip: ['SKIPPED', 'Patient does not want this as a phone notification'] };
  if (!devices.length) return { skip: ['SKIPPED', 'No device allowed notifications'] };
  const base = { tag: notification.id, url: notification.link || '/dashboard', notificationId: notification.id };
  if (!delivery.reminderJobId) {
    if (now.getTime() - notification.createdAt.getTime() > UPDATE_STALE_MS) return { skip: ['SKIPPED', 'Too old to send'] };
    if (PREPARERS[notification.eventType]) {
      const prepared = await PREPARERS[notification.eventType](prisma, notification, { now });
      if (prepared.skip) return { skip: prepared.skip };
    }
    const body = preference?.showMedicationDetails ? notification.message : PRIVATE_BODY[notification.category] ?? notification.message;
    return { devices, payload: { ...base, title: notification.title, body } };
  }
  const reminder = await reminderFor(delivery, now);
  if (reminder.skip) return reminder;
  const { job } = reminder;
  return {
    devices,
    urgency: 'high',
    payload: {
      ...base, tag: `dose-${job.doseId}`, url: '/medications', requireInteraction: true,
      title: job.snoozeCount ? 'Reminder: time for your medicine' : 'Time for your medicine',
      body: `Your ${medicineLabel(preference, job.dose)} dose (${clockLabel(job.dose.localTime)}).`,
      actions: [{ action: 'taken', title: 'Taken' }, { action: 'snooze', title: 'Remind me later' }],
      actionToken: actionToken({ jobId: job.id, userId: delivery.userId }, now),
    },
  };
}

async function sendPushDelivery(delivery, now) {
  if (!pushConfig().enabled) return { status: 'SKIPPED', lastError: 'Phone notifications are not configured' };
  const plan = await preparePush(delivery, now);
  if (plan.skip) return { status: plan.skip[0], lastError: plan.skip[1] };
  let delivered = 0;
  let transient = null;
  for (const device of plan.devices) {
    try {
      await sendPush(device, plan.payload, { urgency: plan.urgency });
      delivered += 1;
      await prisma.pushSubscription.update({ where: { id: device.id }, data: { lastSuccessAt: new Date() } });
    } catch (error) {
      if (error.gone) await prisma.pushSubscription.updateMany({ where: { id: device.id, revokedAt: null }, data: { revokedAt: new Date() } });
      else if (error.transient) transient = error;
    }
  }
  if (delivered) return { status: 'SENT', sentAt: new Date(), lastError: null };
  if (transient) throw transient;
  return { status: 'FAILED', lastError: 'No device accepted the notification' };
}

// ---------------------------------------------------------------- worker step
const finish = (id, data) => prisma.notificationDelivery.updateMany({ where: { id, status: 'PENDING' }, data });
const SENDERS = { WHATSAPP: sendWhatsApp, PUSH: sendPushDelivery };

export async function deliverDue({ now = new Date(), limit = 50 } = {}) {
  const claimed = await claimDue(limit, now);
  let sent = 0;
  for (const delivery of claimed) {
    const send = SENDERS[delivery.channel];
    if (!send) { await finish(delivery.id, { status: 'SKIPPED', lastError: `Unknown channel ${delivery.channel}` }); continue; }
    try {
      const outcome = await send(delivery, now);
      await finish(delivery.id, outcome);
      if (outcome.status === 'SENT') sent += 1;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[delivery.attempts - 1];
      const retry = error?.transient && delay !== undefined;
      await finish(delivery.id, retry
        ? { nextAttemptAt: new Date(now.getTime() + delay), lastError: String(error.message).slice(0, 300) }
        : { status: 'FAILED', lastError: String(error?.message || 'Send failed').slice(0, 300) });
    }
  }
  return sent;
}
