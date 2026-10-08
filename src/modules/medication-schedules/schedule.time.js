// Clock times in the patient's time zone, without a date library. Doses are stored as UTC instants;
// "08:00" always means 08:00 where the patient lives.

export const DEFAULT_TIMEZONE = 'Africa/Lagos';
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimeZone(zone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

const partsIn = (date, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
}).formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));

const offsetMs = (date, timeZone) => {
  const p = partsIn(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
};

/** The UTC instant for a calendar date ("YYYY-MM-DD") and clock time ("HH:MM") in a time zone. */
export function zonedInstant(day, time, timeZone = DEFAULT_TIMEZONE) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  let instant = guess - offsetMs(new Date(guess), timeZone);
  instant = guess - offsetMs(new Date(instant), timeZone); // settles across a daylight-saving change
  return new Date(instant);
}

/** "YYYY-MM-DD" for an instant, as the calendar reads in that time zone. */
export function localDay(date, timeZone = DEFAULT_TIMEZONE) {
  const p = partsIn(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** "HH:MM" on the clock in that time zone. */
export function localClock(date, timeZone = DEFAULT_TIMEZONE) {
  const p = partsIn(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export const dayString = (date) => date.toISOString().slice(0, 10);
export function addDays(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return dayString(date);
}

/** "8:00 am" style label for messages. */
export function clockLabel(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

export function partOfDay(time) {
  const h = Number(time.slice(0, 2));
  return h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
}

// Suggested times for a prescription frequency. The patient can change them; "as needed" and
// "other" have no fixed times.
const FREQUENCY_TIMES = {
  ONCE_DAILY: ['08:00'],
  TWICE_DAILY: ['08:00', '20:00'],
  THREE_TIMES_DAILY: ['08:00', '14:00', '20:00'],
  FOUR_TIMES_DAILY: ['07:00', '12:00', '17:00', '22:00'],
  EVERY_4_HOURS: ['02:00', '06:00', '10:00', '14:00', '18:00', '22:00'],
  EVERY_6_HOURS: ['00:00', '06:00', '12:00', '18:00'],
  EVERY_8_HOURS: ['06:00', '14:00', '22:00'],
  EVERY_12_HOURS: ['08:00', '20:00'],
};
export const suggestedTimes = (frequency) => FREQUENCY_TIMES[frequency] ?? [];
export const isAsNeeded = (frequency) => frequency === 'AS_NEEDED';

/** Last day of a course from a prescription's free-text duration ("7 days", "2 weeks"); null if unclear. */
export function courseEndDay(startDay, duration) {
  const match = /(\d{1,3})\s*(day|week|month)s?/i.exec(String(duration || ''));
  if (!match) return null;
  const days = Number(match[1]) * { day: 1, week: 7, month: 30 }[match[2].toLowerCase()];
  return days > 0 ? addDays(startDay, days - 1) : null;
}

export const sortTimes = (times) => [...new Set(times)].sort();
