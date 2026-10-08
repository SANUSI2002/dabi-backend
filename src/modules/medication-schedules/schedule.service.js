// Medication schedules, the dose records made from them, and their reminders.
//
// - A schedule says when a medicine is taken (times in the patient's time zone). Every change bumps
//   its version and cancels future doses and reminders made for the old version.
// - Doses are created up to 48 hours ahead (materialize). Each future dose gets one reminder job.
// - processDueReminders() turns due jobs into notifications. Before sending it re-checks that the dose
//   is still unconfirmed and the schedule unchanged, and expires reminders more than 2 hours late
//   (after an outage nobody gets a pile of old reminders).
// - A dose's status (NOT_CONFIRMED / TAKEN / SKIPPED / CANCELLED) is what the patient reported. It is
//   never inferred from whether a reminder was delivered or read.
// Workers claim rows with FOR UPDATE SKIP LOCKED, so several API instances can run them safely.
import { randomUUID } from 'node:crypto';
import prisma from '../../config/db.js';
import { recordAudit } from '../audit/audit.service.js';
import { notify } from '../notifications/notify.service.js';
import * as T from './schedule.time.js';

export const HORIZON_MS = 48 * 3_600_000;
export const STALE_MS = 2 * 3_600_000;
export const SNOOZE_MS = 30 * 60_000;
export const MAX_SNOOZES = 3;
const EARLY_MS = 2 * 3_600_000;
const LIVE = ['ACTIVE', 'PAUSED'];
const PENDING_JOB = ['SCHEDULED', 'SNOOZED'];

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const utc = (date) => date.toISOString();

export const scheduleView = (s) => ({
  id: s.id, source: s.source, prescriptionItemId: s.prescriptionItemId, name: s.name, dosage: s.dosage, instructions: s.instructions,
  asNeeded: s.asNeeded, times: s.times, timezone: s.timezone, startDate: T.dayString(s.startDate), endDate: s.endDate ? T.dayString(s.endDate) : null,
  status: s.status, remindersEnabled: s.remindersEnabled, version: s.version, updatedAt: s.updatedAt,
});

export const doseView = (d) => ({
  id: d.id, scheduleId: d.scheduleId, scheduledFor: d.scheduledFor, localTime: d.localTime, status: d.status,
  confirmedAt: d.confirmedAt, confirmedVia: d.confirmedVia,
  medicine: d.schedule ? { name: d.schedule.name, dosage: d.schedule.dosage, instructions: d.schedule.instructions } : undefined,
  reminder: d.reminder ? { status: d.reminder.status, dueAt: d.reminder.dueAt, snoozeCount: d.reminder.snoozeCount } : null,
});

const timezoneOf = async (db, userId) => (await db.notificationPreference.findUnique({ where: { userId }, select: { timezone: true } }))?.timezone || T.DEFAULT_TIMEZONE;

// ---------------------------------------------------------------- dose creation

/** Creates this schedule's doses (and reminder jobs) up to 48 hours ahead. Safe to run repeatedly. */
export async function materializeSchedule(db, schedule, now = new Date()) {
  const until = new Date(now.getTime() + HORIZON_MS);
  const end = schedule.endDate ? T.dayString(schedule.endDate) : null;
  const completed = end && T.localDay(now, schedule.timezone) > end;
  if (schedule.status === 'ACTIVE' && !schedule.asNeeded && schedule.times.length) {
    const from = schedule.materializedUntil ?? now;
    const start = T.dayString(schedule.startDate);
    for (let day = T.localDay(from, schedule.timezone); day <= T.localDay(until, schedule.timezone); day = T.addDays(day, 1)) {
      if (day < start) continue;
      if (end && day > end) break;
      for (const time of schedule.times) {
        const at = T.zonedInstant(day, time, schedule.timezone);
        if (at <= from || at > until) continue;
        // A dose cancelled by an older version comes back if the new version has the same time.
        const rows = await db.$queryRaw`
          INSERT INTO "medication_doses" ("id", "schedule_id", "user_id", "schedule_version", "scheduled_for", "local_time", "status", "updated_at")
          VALUES (${randomUUID()}, ${schedule.id}, ${schedule.userId}, ${schedule.version}, (${utc(at)}::timestamptz AT TIME ZONE 'UTC'), ${time}, 'NOT_CONFIRMED', (now() AT TIME ZONE 'UTC'))
          ON CONFLICT ("schedule_id", "scheduled_for") DO UPDATE
            SET "status" = 'NOT_CONFIRMED', "schedule_version" = EXCLUDED."schedule_version", "local_time" = EXCLUDED."local_time",
                "confirmed_at" = NULL, "confirmed_via" = NULL, "updated_at" = EXCLUDED."updated_at"
            WHERE "medication_doses"."status" = 'CANCELLED' AND "medication_doses"."schedule_version" < EXCLUDED."schedule_version"
          RETURNING "id"`;
        if (!rows.length || !schedule.remindersEnabled || at <= now) continue;
        await db.$executeRaw`
          INSERT INTO "reminder_jobs" ("id", "dose_id", "user_id", "due_at", "original_due_at", "status", "updated_at")
          VALUES (${randomUUID()}, ${rows[0].id}, ${schedule.userId}, (${utc(at)}::timestamptz AT TIME ZONE 'UTC'), (${utc(at)}::timestamptz AT TIME ZONE 'UTC'), 'SCHEDULED', (now() AT TIME ZONE 'UTC'))
          ON CONFLICT ("dose_id") DO UPDATE
            SET "status" = 'SCHEDULED', "due_at" = EXCLUDED."due_at", "original_due_at" = EXCLUDED."original_due_at", "snooze_count" = 0,
                "processed_at" = NULL, "last_error" = NULL, "updated_at" = EXCLUDED."updated_at"`;
      }
    }
  }
  await db.medicationSchedule.updateMany({
    where: { id: schedule.id, version: schedule.version },
    data: { materializedUntil: until, ...(completed && schedule.status === 'ACTIVE' ? { status: 'COMPLETED' } : {}) },
  });
}

/** Worker step: schedules whose doses run out within the next 47 hours. */
export async function materializeDue({ now = new Date(), limit = 100 } = {}) {
  const threshold = new Date(now.getTime() + HORIZON_MS - 3_600_000);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw`
      SELECT "id" FROM "medication_schedules"
      WHERE "status" = 'ACTIVE' AND ("materialized_until" IS NULL OR "materialized_until" < (${utc(threshold)}::timestamptz AT TIME ZONE 'UTC'))
      ORDER BY "materialized_until" NULLS FIRST LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (!claimed.length) return 0;
    const schedules = await tx.medicationSchedule.findMany({ where: { id: { in: claimed.map((row) => row.id) } } });
    for (const schedule of schedules) await materializeSchedule(tx, schedule, now);
    return schedules.length;
  }, { timeout: 60_000 });
}

/** Brings one patient's doses up to date (used when they open their medicines, so the list never waits for the worker). */
export async function materializeForUser(userId, now = new Date()) {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`SELECT "id" FROM "medication_schedules" WHERE "user_id" = ${userId} AND "status" = 'ACTIVE' FOR UPDATE`;
    if (!locked.length) return;
    const schedules = await tx.medicationSchedule.findMany({ where: { id: { in: locked.map((row) => row.id) } } });
    for (const schedule of schedules) await materializeSchedule(tx, schedule, now);
  }, { timeout: 30_000 });
}

/** Cancels a schedule's future unconfirmed doses and every reminder still waiting to go out. */
async function cancelOutstanding(tx, scheduleId, now, reason) {
  const jobs = await tx.reminderJob.findMany({ where: { dose: { scheduleId }, status: { in: [...PENDING_JOB, 'SENT'] } }, select: { id: true } });
  const jobIds = jobs.map((job) => job.id);
  if (jobIds.length) {
    await tx.notificationDelivery.updateMany({ where: { reminderJobId: { in: jobIds }, status: 'PENDING' }, data: { status: 'CANCELLED', lastError: reason } });
    await tx.reminderJob.updateMany({ where: { id: { in: jobIds }, status: { in: PENDING_JOB } }, data: { status: 'CANCELLED', lastError: reason } });
  }
  await tx.medicationDose.updateMany({ where: { scheduleId, status: 'NOT_CONFIRMED', scheduledFor: { gt: now } }, data: { status: 'CANCELLED' } });
}

async function cancelReminder(tx, jobId, reason) {
  if (!jobId) return;
  await tx.notificationDelivery.updateMany({ where: { reminderJobId: jobId, status: 'PENDING' }, data: { status: 'CANCELLED', lastError: reason } });
  await tx.reminderJob.updateMany({ where: { id: jobId, status: { in: PENDING_JOB } }, data: { status: 'CANCELLED', lastError: reason } });
}

// ---------------------------------------------------------------- schedules (patient)

/** Issued prescription items the patient has not set up yet, with suggested times. */
export async function suggestions(userId, now = new Date()) {
  const items = await prisma.prescriptionItem.findMany({
    where: { prescription: { patientId: userId, status: 'ISSUED' } },
    select: {
      id: true, medicationName: true, dosage: true, frequency: true, duration: true, route: true, indication: true,
      prescription: { select: { id: true, issuedAt: true, instructions: true, doctorProfile: { select: { user: { select: { full_name: true } } } } } },
    },
    orderBy: { createdAt: 'desc' }, take: 100,
  });
  if (!items.length) return [];
  const live = await prisma.medicationSchedule.findMany({ where: { userId, prescriptionItemId: { in: items.map((i) => i.id) }, status: { in: LIVE } }, select: { prescriptionItemId: true } });
  const taken = new Set(live.map((s) => s.prescriptionItemId));
  const today = T.localDay(now, await timezoneOf(prisma, userId));
  return items.filter((item) => !taken.has(item.id)).map((item) => ({
    prescriptionItemId: item.id, prescriptionId: item.prescription.id, issuedAt: item.prescription.issuedAt,
    prescriber: item.prescription.doctorProfile?.user?.full_name ?? null,
    medicationName: item.medicationName, dosage: item.dosage, frequency: item.frequency, duration: item.duration, route: item.route, indication: item.indication,
    asNeeded: T.isAsNeeded(item.frequency), suggestedTimes: T.suggestedTimes(item.frequency), suggestedEndDate: T.courseEndDay(today, item.duration),
  }));
}

export async function listSchedules(userId) {
  const schedules = await prisma.medicationSchedule.findMany({
    where: { userId, OR: [{ status: { in: LIVE } }, { updatedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }] },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 100,
  });
  return schedules.map(scheduleView);
}

const auditSchedule = (tx, userId, action, schedule, summary) => recordAudit(tx, { actorUserId: userId, action, summary, resourceType: 'medication_schedule', resourceId: schedule.id });

export async function createSchedule(userId, input, now = new Date()) {
  const schedule = await prisma.$transaction(async (tx) => {
    const timezone = await timezoneOf(tx, userId);
    let details = { source: 'PATIENT', name: input.name, dosage: input.dosage ?? null, asNeeded: Boolean(input.asNeeded), prescriptionItemId: null };
    if (input.prescriptionItemId) {
      const item = await tx.prescriptionItem.findFirst({ where: { id: input.prescriptionItemId, prescription: { patientId: userId, status: 'ISSUED' } } });
      if (!item) fail(404, 'NOT_FOUND', 'Prescription not found.');
      if (await tx.medicationSchedule.findFirst({ where: { prescriptionItemId: item.id, status: { in: LIVE } }, select: { id: true } })) {
        fail(409, 'ALREADY_SCHEDULED', 'Reminders are already set up for this medicine.');
      }
      details = { source: 'PRESCRIPTION', name: item.medicationName, dosage: item.dosage, asNeeded: T.isAsNeeded(item.frequency), prescriptionItemId: item.id };
    }
    if (!details.name) fail(400, 'NAME_REQUIRED', 'Give the medicine a name.');
    const times = details.asNeeded ? [] : T.sortTimes(input.times ?? []);
    if (!details.asNeeded && !times.length) fail(400, 'TIMES_REQUIRED', 'Choose at least one time to take this medicine.');
    const startDate = input.startDate ?? T.localDay(now, timezone);
    if (input.endDate && input.endDate < startDate) fail(400, 'INVALID_DATES', 'The last day cannot be before the first day.');
    const created = await tx.medicationSchedule.create({ data: {
      userId, ...details, medicationId: input.medicationId ?? null, instructions: input.instructions ?? null, times, timezone,
      startDate: new Date(`${startDate}T00:00:00Z`), endDate: input.endDate ? new Date(`${input.endDate}T00:00:00Z`) : null,
      remindersEnabled: details.asNeeded ? false : input.remindersEnabled ?? true, materializedUntil: now,
    } });
    await auditSchedule(tx, userId, 'MEDICATION_SCHEDULE_SAVED', created, details.asNeeded
      ? `You added ${created.name} to your medicines (as needed)`
      : `You set up ${created.name} at ${times.map(T.clockLabel).join(', ')}`);
    await materializeSchedule(tx, created, now);
    return created;
  });
  return scheduleView(await prisma.medicationSchedule.findUnique({ where: { id: schedule.id } }));
}

async function lockSchedule(tx, userId, id) {
  const [row] = await tx.$queryRaw`SELECT "id" FROM "medication_schedules" WHERE "id" = ${id} AND "user_id" = ${userId} FOR UPDATE`;
  if (!row) fail(404, 'NOT_FOUND', 'Medicine not found.');
  return tx.medicationSchedule.findUnique({ where: { id } });
}

export async function updateSchedule(userId, id, input, now = new Date()) {
  const schedule = await prisma.$transaction(async (tx) => {
    const current = await lockSchedule(tx, userId, id);
    if (!LIVE.includes(current.status)) fail(409, 'NOT_LIVE', 'This medicine has been stopped. Add it again to restart reminders.');
    const data = {};
    if (input.name !== undefined) {
      if (current.source === 'PRESCRIPTION') fail(400, 'PRESCRIBED_NAME', 'The name of a prescribed medicine cannot be changed.');
      data.name = input.name;
    }
    if (input.dosage !== undefined && current.source === 'PATIENT') data.dosage = input.dosage;
    if (input.instructions !== undefined) data.instructions = input.instructions;
    if (input.times !== undefined && !current.asNeeded) {
      if (!input.times.length) fail(400, 'TIMES_REQUIRED', 'Choose at least one time to take this medicine.');
      data.times = T.sortTimes(input.times);
    }
    if (input.endDate !== undefined) {
      if (input.endDate && input.endDate < T.dayString(current.startDate)) fail(400, 'INVALID_DATES', 'The last day cannot be before the first day.');
      data.endDate = input.endDate ? new Date(`${input.endDate}T00:00:00Z`) : null;
    }
    if (input.remindersEnabled !== undefined && !current.asNeeded) data.remindersEnabled = input.remindersEnabled;
    if (input.paused !== undefined) data.status = input.paused ? 'PAUSED' : 'ACTIVE';
    const updated = await tx.medicationSchedule.update({ where: { id }, data: { ...data, version: { increment: 1 }, materializedUntil: now } });
    await cancelOutstanding(tx, id, now, 'Schedule changed');
    await auditSchedule(tx, userId, 'MEDICATION_SCHEDULE_SAVED', updated, updated.status === 'PAUSED'
      ? `You paused reminders for ${updated.name}`
      : `You changed ${updated.name}${updated.asNeeded ? '' : ` to ${updated.times.map(T.clockLabel).join(', ')}`}`);
    await materializeSchedule(tx, updated, now);
    return updated;
  });
  return scheduleView(await prisma.medicationSchedule.findUnique({ where: { id: schedule.id } }));
}

export async function stopSchedule(userId, id, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const current = await lockSchedule(tx, userId, id);
    if (!LIVE.includes(current.status)) return scheduleView(current);
    const stopped = await tx.medicationSchedule.update({ where: { id }, data: { status: 'STOPPED', version: { increment: 1 } } });
    await cancelOutstanding(tx, id, now, 'Medicine stopped');
    await auditSchedule(tx, userId, 'MEDICATION_SCHEDULE_STOPPED', stopped, `You stopped ${stopped.name}`);
    return scheduleView(stopped);
  });
}

/** A cancelled prescription stops its reminders. Runs inside the cancellation's transaction. */
export async function stopSchedulesForPrescriptionItems(tx, itemIds, now = new Date()) {
  if (!itemIds.length) return;
  const schedules = await tx.medicationSchedule.findMany({ where: { prescriptionItemId: { in: itemIds }, status: { in: LIVE } }, select: { id: true } });
  for (const { id } of schedules) {
    await tx.medicationSchedule.update({ where: { id }, data: { status: 'STOPPED', version: { increment: 1 } } });
    await cancelOutstanding(tx, id, now, 'Prescription cancelled');
  }
}

// ---------------------------------------------------------------- doses

/** The doses on one calendar day in the patient's time zone (today by default). */
export async function dosesForDay(userId, day, now = new Date()) {
  await materializeForUser(userId, now);
  const timezone = await timezoneOf(prisma, userId);
  const date = day ?? T.localDay(now, timezone);
  const doses = await prisma.medicationDose.findMany({
    where: { userId, status: { not: 'CANCELLED' }, scheduledFor: { gte: T.zonedInstant(date, '00:00', timezone), lt: T.zonedInstant(T.addDays(date, 1), '00:00', timezone) } },
    include: { schedule: true, reminder: true },
    orderBy: { scheduledFor: 'asc' },
  });
  return { day: date, timezone, doses: doses.map(doseView) };
}

const DOSE_ACTIONS = { TAKEN: 'MEDICATION_DOSE_TAKEN', SKIPPED: 'MEDICATION_DOSE_SKIPPED' };

/**
 * Records a dose as taken or skipped, from the app or a WhatsApp button. Recording the same answer
 * twice changes nothing and says so (`alreadyRecorded`). Cancels the dose's pending reminder.
 */
export async function recordDose(userId, doseId, status, { via = 'APP', now = new Date(), req } = {}) {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`SELECT "id" FROM "medication_doses" WHERE "id" = ${doseId} AND "user_id" = ${userId} FOR UPDATE`;
    if (!row) fail(404, 'NOT_FOUND', 'Dose not found.');
    const dose = await tx.medicationDose.findUnique({ where: { id: doseId }, include: { schedule: true, reminder: true } });
    if (dose.status === status) return { dose: doseView(dose), alreadyRecorded: true };
    if (dose.status === 'CANCELLED') fail(409, 'DOSE_CANCELLED', 'This dose is no longer scheduled.');
    if (dose.scheduledFor.getTime() - now.getTime() > EARLY_MS) fail(409, 'TOO_EARLY', 'A dose can be recorded from two hours before it is due.');
    await tx.medicationDose.update({ where: { id: doseId }, data: { status, confirmedAt: now, confirmedVia: via } });
    await cancelReminder(tx, dose.reminder?.id, `Dose ${status.toLowerCase()}`);
    const where = via === 'WHATSAPP' ? ' on WhatsApp' : '';
    await recordAudit(tx, {
      actorUserId: userId, action: DOSE_ACTIONS[status], resourceType: 'medication_dose', resourceId: doseId,
      summary: `You recorded your ${T.clockLabel(dose.localTime)} dose of ${dose.schedule.name} as ${status === 'TAKEN' ? 'taken' : 'skipped'}${where}`,
    }, { req: via === 'WHATSAPP' ? null : req });
    const updated = await tx.medicationDose.findUnique({ where: { id: doseId }, include: { schedule: true, reminder: true } });
    return { dose: doseView(updated), alreadyRecorded: false };
  });
}

/**
 * "Remind me later" from WhatsApp: the reminder comes back in 30 minutes, at most three times.
 * Only the reminder moves; the dose keeps its prescribed time.
 */
export async function snoozeReminder(userId, jobId, { now = new Date() } = {}) {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`SELECT "id" FROM "reminder_jobs" WHERE "id" = ${jobId} AND "user_id" = ${userId} FOR UPDATE`;
    if (!row) return { outcome: 'CLOSED' };
    const job = await tx.reminderJob.findUnique({ where: { id: jobId }, include: { dose: { include: { schedule: true } } } });
    const timezone = job.dose.schedule.timezone;
    if (job.dose.status === 'CANCELLED') return { outcome: 'CLOSED' };
    if (job.dose.status !== 'NOT_CONFIRMED') return { outcome: 'ALREADY_RECORDED' };
    if (job.status === 'SNOOZED') return { outcome: 'SNOOZED', at: T.localClock(job.dueAt, timezone) };
    if (job.status !== 'SENT') return { outcome: 'CLOSED' };
    if (job.snoozeCount >= MAX_SNOOZES) return { outcome: 'LIMIT' };
    const dueAt = new Date(now.getTime() + SNOOZE_MS);
    await tx.reminderJob.update({ where: { id: jobId }, data: { status: 'SNOOZED', dueAt, snoozeCount: { increment: 1 } } });
    await recordAudit(tx, {
      actorUserId: userId, action: 'MEDICATION_REMINDER_SNOOZED', resourceType: 'medication_dose', resourceId: job.doseId,
      summary: `You asked to be reminded again about your ${T.clockLabel(job.dose.localTime)} dose of ${job.dose.schedule.name}`,
    }, { req: null });
    return { outcome: 'SNOOZED', at: T.localClock(dueAt, timezone) };
  });
}

// ---------------------------------------------------------------- reminders (worker)

async function reminderProblem(tx, job, now) {
  const { dose } = job;
  const { schedule } = dose;
  if (dose.status !== 'NOT_CONFIRMED') return ['CANCELLED', 'Dose already recorded'];
  if (schedule.status !== 'ACTIVE' || !schedule.remindersEnabled || dose.scheduleVersion !== schedule.version) return ['CANCELLED', 'Schedule changed'];
  if (schedule.prescriptionItemId) {
    const item = await tx.prescriptionItem.findUnique({ where: { id: schedule.prescriptionItemId }, select: { prescription: { select: { status: true } } } });
    if (item?.prescription?.status !== 'ISSUED') return ['CANCELLED', 'Prescription no longer active'];
  }
  if (now.getTime() - job.dueAt.getTime() > STALE_MS) return ['EXPIRED', 'Too late to remind'];
  return null;
}

/** Worker step: due reminders become in-app notifications plus queued WhatsApp deliveries. */
export async function processDueReminders({ now = new Date(), limit = 100 } = {}) {
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw`
      SELECT "id" FROM "reminder_jobs"
      WHERE "status" IN ('SCHEDULED', 'SNOOZED') AND "due_at" <= (${utc(now)}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "due_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    let sent = 0;
    for (const { id } of due) {
      const job = await tx.reminderJob.findUnique({ where: { id }, include: { dose: { include: { schedule: true } } } });
      const problem = await reminderProblem(tx, job, now);
      if (problem) {
        await tx.reminderJob.update({ where: { id }, data: { status: problem[0], lastError: problem[1], processedAt: now } });
        continue;
      }
      const { dose } = job;
      const medicine = `${dose.schedule.name}${dose.schedule.dosage ? ` (${dose.schedule.dosage})` : ''}`;
      await notify(tx, {
        userId: job.userId, eventType: 'medication.dose_due', reminderJobId: job.id, link: '/medications',
        eventKey: `medication.dose_due:${dose.id}:${job.snoozeCount}`,
        title: job.snoozeCount ? 'Reminder: time for your medicine' : 'Time for your medicine',
        message: `${medicine}, your ${T.clockLabel(dose.localTime)} dose. Tap Taken once you have taken it.`,
      });
      await tx.reminderJob.update({ where: { id }, data: { status: 'SENT', processedAt: now, lastError: null } });
      sent += 1;
    }
    return sent;
  }, { timeout: 60_000 });
}
