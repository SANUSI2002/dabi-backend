// Sends queued WhatsApp deliveries (worker step).
//
// Each delivery is claimed with FOR UPDATE SKIP LOCKED and leased, so a crash mid-send is retried
// later instead of lost, and two instances never send the same row. Just before sending it re-checks
// everything that may have changed since the notification was made: WhatsApp still on, that kind of
// update still wanted, a number still linked, and for reminders that the dose is still unconfirmed.
// Temporary failures are retried with back-off; permanent ones are marked FAILED. The in-app
// notification is never touched here.
import prisma from '../../config/db.js';
import { clockLabel, partOfDay } from '../medication-schedules/schedule.time.js';
import { ACTIONS, buttonPayload, reminderMessage, updateMessage } from '../whatsapp/whatsapp.messages.js';
import { whatsappProvider } from '../whatsapp/whatsapp.provider.js';
import { wantsWhatsApp } from './notify.service.js';

const LEASE_MS = 2 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const REMINDER_STALE_MS = 2 * 3_600_000;
const UPDATE_STALE_MS = 24 * 3_600_000;

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

/** What to send for one delivery, or why it should not be sent any more. */
async function prepare(delivery, now) {
  const { notification } = delivery;
  const age = now.getTime() - notification.createdAt.getTime();
  const [preference, connection] = await Promise.all([
    prisma.notificationPreference.findUnique({ where: { userId: delivery.userId } }),
    prisma.whatsAppConnection.findFirst({ where: { userId: delivery.userId, status: 'ACTIVE' } }),
  ]);
  if (!wantsWhatsApp(preference, notification.category)) return { skip: ['SKIPPED', 'Patient does not want this on WhatsApp'] };
  if (!connection) return { skip: ['SKIPPED', 'No WhatsApp number linked'] };
  if (!delivery.reminderJobId) {
    if (age > UPDATE_STALE_MS) return { skip: ['SKIPPED', 'Too old to send'] };
    return { connection, message: updateMessage(notification.title) };
  }
  const job = await prisma.reminderJob.findUnique({ where: { id: delivery.reminderJobId }, include: { dose: { include: { schedule: true } } } });
  if (!job || job.dose.status !== 'NOT_CONFIRMED' || job.status === 'CANCELLED') return { skip: ['CANCELLED', 'Dose already recorded or reminder cancelled'] };
  if (age > REMINDER_STALE_MS) return { skip: ['SKIPPED', 'Too late to remind'] };
  const { schedule } = job.dose;
  const label = preference.showMedicationDetails
    ? `${schedule.name}${schedule.dosage ? ` ${schedule.dosage}` : ''}`
    : `${partOfDay(job.dose.localTime)} medicine`;
  return {
    connection,
    message: reminderMessage({
      label, time: clockLabel(job.dose.localTime),
      takenPayload: buttonPayload(ACTIONS.TAKEN, job.id, connection.id),
      snoozePayload: buttonPayload(ACTIONS.SNOOZE, job.id, connection.id),
    }),
  };
}

const finish = (id, data) => prisma.notificationDelivery.updateMany({ where: { id, status: 'PENDING' }, data });

export async function deliverDue({ now = new Date(), limit = 50 } = {}) {
  const claimed = await claimDue(limit, now);
  let sent = 0;
  for (const delivery of claimed) {
    const provider = whatsappProvider();
    if (!provider) {
      await finish(delivery.id, { status: 'SKIPPED', lastError: 'WhatsApp is not configured' });
      continue;
    }
    const plan = await prepare(delivery, now);
    if (plan.skip) {
      await finish(delivery.id, { status: plan.skip[0], lastError: plan.skip[1] });
      continue;
    }
    try {
      const { messageId } = await provider.sendTemplate(plan.connection.phone, plan.message);
      await finish(delivery.id, { status: 'SENT', providerMessageId: messageId, connectionId: plan.connection.id, sentAt: new Date(), lastError: null });
      sent += 1;
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
