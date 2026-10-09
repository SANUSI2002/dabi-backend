// Appointment updates for patients, through the central notification service:
// - when the doctor confirms, declines or cancels (called inside that change's transaction);
// - reminders for confirmed appointments the day before and about an hour before (worker step).
// Times are written in the patient's time zone. WhatsApp messages never name the doctor or the reason
// for the visit; the in-app notification can, because it is inside Sabi.
import prisma from '../../config/db.js';
import { DEFAULT_TIMEZONE, addDays, clockLabel, localClock, localDay } from '../medication-schedules/schedule.time.js';
import { appointmentReminderMessage } from '../whatsapp/whatsapp.messages.js';
import { notify } from './notify.service.js';

const HOUR = 3_600_000;
const KIND = { VIRTUAL: 'video consultation', IN_PERSON: 'in-person appointment' };
const noticeSelect = {
  id: true, patientId: true, startsAt: true, consultationType: true, status: true, confirmedAt: true,
  dependent: { select: { fullName: true } }, doctorProfile: { select: { user: { select: { full_name: true } } } },
};

/** "today at 10:00 am", "tomorrow at 9:30 am" or "on Fri 10 Oct at 2:00 pm", in that time zone. */
export function whenLabel(date, timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  const day = localDay(date, timeZone);
  const today = localDay(now, timeZone);
  const time = clockLabel(localClock(date, timeZone));
  if (day === today) return `today at ${time}`;
  if (day === addDays(today, 1)) return `tomorrow at ${time}`;
  return `on ${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(date)} at ${time}`;
}

const timezoneOf = async (db, userId) => (await db.notificationPreference.findUnique({ where: { userId }, select: { timezone: true } }))?.timezone || DEFAULT_TIMEZONE;
const describe = (a) => ({
  kind: KIND[a.consultationType] ?? 'appointment',
  doctor: a.doctorProfile?.user?.full_name || 'Your doctor',
  forWhom: a.dependent?.fullName ? ` for ${a.dependent.fullName}` : '',
  join: a.consultationType === 'VIRTUAL' ? ' You can join from Appointments in Sabi.' : '',
});

const CHANGES = {
  CONFIRMED: ['appointment.confirmed', 'Your appointment is confirmed', (d, when) => `${d.doctor} confirmed your ${d.kind}${d.forWhom} ${when}.${d.join}`],
  DECLINED: ['appointment.declined', 'Appointment request not accepted', (d, when) => `${d.doctor} couldn't accept your ${d.kind} request${d.forWhom} for ${when.replace(/^on /, '')}. Open Appointments in Sabi to see why or book another time.`],
  CANCELLED: ['appointment.cancelled', 'Your appointment was cancelled', (d, when) => `${d.doctor} cancelled your ${d.kind}${d.forWhom} ${when}. Open Appointments in Sabi to see why or book another time.`],
};

/** Tells the patient about a doctor's decision. Run inside the transaction that made it. */
export async function notifyAppointmentChange(tx, appointmentId, status, now = new Date()) {
  const change = CHANGES[status];
  if (!change) return null;
  const appointment = await tx.doctorAppointment.findFirst({ where: { id: appointmentId }, select: noticeSelect });
  if (!appointment?.patientId || !appointment.startsAt) return null;
  const when = whenLabel(appointment.startsAt, await timezoneOf(tx, appointment.patientId), now);
  return notify(tx, {
    userId: appointment.patientId, eventType: change[0], eventKey: `${change[0]}:${appointment.id}`, link: '/appointments',
    title: change[1], message: change[2](describe(appointment), when),
  });
}

/** Which reminder is due now, if any: the day-before one from 24 h to 3 h ahead, the last one within 65 minutes. */
function reminderWindow(appointment, now) {
  const lead = appointment.startsAt.getTime() - now.getTime();
  if (lead <= 0) return null;
  if (lead <= 65 * 60_000) return '1h';
  // Just confirmed a few hours ahead: the confirmation already said when, so skip the day-before reminder.
  const justConfirmed = appointment.confirmedAt && now.getTime() - appointment.confirmedAt.getTime() < HOUR;
  if (lead >= 3 * HOUR && lead <= 24 * HOUR && !justConfirmed) return '24h';
  return null;
}

/** Worker step: reminders for confirmed appointments in the next 24 hours. Each is created once. */
export async function sendAppointmentReminders({ now = new Date(), limit = 200 } = {}) {
  const upcoming = await prisma.doctorAppointment.findMany({
    where: { status: 'CONFIRMED', startsAt: { gt: now, lte: new Date(now.getTime() + 24 * HOUR) } },
    select: noticeSelect, orderBy: { startsAt: 'asc' }, take: limit,
  });
  const due = upcoming.map((a) => ({ appointment: a, window: reminderWindow(a, now) })).filter((r) => r.window)
    .map((r) => ({ ...r, key: `appointment.reminder:${r.appointment.id}:${r.window}` }));
  if (!due.length) return 0;
  const done = new Set((await prisma.notification.findMany({ where: { eventKey: { in: due.map((r) => r.key) } }, select: { eventKey: true } })).map((n) => n.eventKey));
  let sent = 0;
  for (const { appointment, key } of due.filter((r) => !done.has(r.key))) {
    const d = describe(appointment);
    const when = whenLabel(appointment.startsAt, await timezoneOf(prisma, appointment.patientId), now);
    try {
      await prisma.$transaction((tx) => notify(tx, {
        userId: appointment.patientId, eventType: 'appointment.reminder', eventKey: key, link: '/appointments',
        title: 'Appointment reminder', message: `Your ${d.kind} with ${d.doctor}${d.forWhom} is ${when}.${d.join}`,
      }));
      sent += 1;
    } catch (error) {
      if (error?.code !== 'P2002') throw error; // another instance made it first
    }
  }
  return sent;
}

/** WhatsApp text for a reminder, re-checked at send time: nothing goes out for a cancelled or past appointment. */
export async function prepareAppointmentReminder(db, notification, { now = new Date() } = {}) {
  const id = String(notification.eventKey || '').split(':')[1];
  const appointment = id ? await db.doctorAppointment.findFirst({ where: { id }, select: noticeSelect }) : null;
  if (!appointment || appointment.status !== 'CONFIRMED') return { skip: ['CANCELLED', 'Appointment no longer confirmed'] };
  if (appointment.startsAt <= now) return { skip: ['SKIPPED', 'Appointment already started'] };
  const when = whenLabel(appointment.startsAt, await timezoneOf(db, appointment.patientId), now);
  return { message: appointmentReminderMessage({ what: KIND[appointment.consultationType] ?? 'appointment', when }) };
}
