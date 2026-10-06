import { z } from 'zod';
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0,10) === v, 'Invalid date');
const minutes = value => Number(value.slice(0,2)) * 60 + Number(value.slice(3));
export const scheduleSchema = z.object({
  timezone: z.enum(['Africa/Lagos', 'UTC']), durationMinutes: z.number().int().min(5).max(240), bufferMinutes: z.number().int().min(0).max(120),
  weeklyHours: z.array(z.object({ day: z.number().int().min(0).max(6), start: hhmm, end: hhmm, consultationTypes: z.array(z.enum(['VIRTUAL', 'IN_PERSON'])).min(1).max(2),
    breaks: z.array(z.object({ start: hhmm, end: hhmm }).strict().refine(b => minutes(b.end) > minutes(b.start), 'Break end must follow start')).max(5).default([]),
  }).strict().refine(r => minutes(r.end) > minutes(r.start), 'Working hours must end after they start')
    .refine(r => r.breaks.every(b => minutes(b.start) >= minutes(r.start) && minutes(b.end) <= minutes(r.end)), 'Breaks must fall inside working hours')).max(14),
}).strict();
export const publishScheduleSchema = z.object({ from: day, to: day }).strict().refine(v => v.to >= v.from && Date.parse(v.to) - Date.parse(v.from) <= 30 * 86400000, 'Choose a range of at most 31 days');
export const exceptionSchema = z.object({ date: day, hours: scheduleSchema.shape.weeklyHours }).strict().refine(v=>v.hours.length>0 && v.hours.every(h=>h.day===new Date(`${v.date}T00:00:00Z`).getUTCDay()), 'Working hours must match the selected date');
export const timeBlockSchema = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), reason: z.string().trim().min(2).max(200) }).strict()
  .refine(v => new Date(v.endsAt) > new Date(v.startsAt) && new Date(v.endsAt) > new Date(), 'Choose a valid future block');
export function scheduleInstant(day, hhmm, timezone) {
  // Nigeria has a fixed UTC+01:00 offset. Store UTC instants; never use the server/browser timezone.
  return new Date(`${day}T${hhmm}:00${timezone === 'Africa/Lagos' ? '+01:00' : 'Z'}`);
}
export function generateSchedule(settings, range, blocks = [], now = new Date()) {
  const cfg = scheduleSchema.parse(settings); const dates = publishScheduleSchema.parse(range);
  if (Date.parse(dates.to) > now.getTime() + 180 * 86400000) throw new Error('Schedules may be published up to 180 days ahead');
  const slots = [];
  for (let d = Date.parse(`${dates.from}T00:00:00Z`); d <= Date.parse(`${dates.to}T00:00:00Z`); d += 86400000) {
    const iso = new Date(d).toISOString().slice(0,10);
    for (const rule of cfg.weeklyHours.filter(r => r.day === new Date(d).getUTCDay())) {
      const stop = scheduleInstant(iso, rule.end, cfg.timezone).getTime();
      const breaks = rule.breaks.map(b => ({ startsAt: scheduleInstant(iso,b.start,cfg.timezone), endsAt: scheduleInstant(iso,b.end,cfg.timezone) }));
      for (let start = scheduleInstant(iso,rule.start,cfg.timezone).getTime(); start + cfg.durationMinutes * 60000 <= stop; start += (cfg.durationMinutes + cfg.bufferMinutes) * 60000) {
        const end = start + cfg.durationMinutes * 60000;
        if (start <= now.getTime() || [...blocks,...breaks].some(b => start < new Date(b.endsAt).getTime() && end > new Date(b.startsAt).getTime())) continue;
        if (slots.some(s => start < s.endsAt.getTime() && end > s.startsAt.getTime())) throw new Error('Weekly working periods overlap');
        slots.push({ startsAt: new Date(start), endsAt: new Date(end), consultationTypes: [...new Set(rule.consultationTypes)] });
        if (slots.length > 1000) throw new Error('Publish fewer days (maximum 1000 slots per request)');
      }
    }
  }
  return slots;
}

const sameTypes = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
/**
 * Matches freshly generated slots against the practitioner's live (uncancelled) slots in the same range.
 * A generated slot that is already published exactly (same times and consultation types) is kept as is;
 * one that overlaps anything else is a conflict, so the whole publish is refused rather than half-applied.
 * Both lists are sorted by start time and swept once, so this is O(n + m) for up to 1000 slots.
 */
export function reconcileSlots(generated, live) {
  const slots = [...generated].sort((a, b) => a.startsAt - b.startsAt);
  const current = [...live].sort((a, b) => a.startsAt - b.startsAt);
  const toCreate = [];
  let existing = 0, first = 0;
  for (const slot of slots) {
    while (first < current.length && current[first].endsAt <= slot.startsAt) first++;
    const overlaps = [];
    for (let i = first; i < current.length && current[i].startsAt < slot.endsAt; i++) if (current[i].endsAt > slot.startsAt) overlaps.push(current[i]);
    if (!overlaps.length) { toCreate.push(slot); continue; }
    const [only] = overlaps;
    if (overlaps.length === 1 && +only.startsAt === +slot.startsAt && +only.endsAt === +slot.endsAt && sameTypes(only.consultationTypes, slot.consultationTypes)) { existing++; continue; }
    return { conflict: true, toCreate: [], existing };
  }
  return { conflict: false, toCreate, existing };
}
