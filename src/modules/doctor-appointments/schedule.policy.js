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
