import { z } from 'zod';

export const CONSULTATION_TYPES = ['VIRTUAL', 'IN_PERSON'];
export const STATUSES = ['REQUESTED', 'CONFIRMED', 'DECLINED', 'CANCELLED', 'COMPLETED'];
export const SLOT_MINUTES = { min: 5, max: 240 };
export const MAX_SLOTS_PER_REQUEST = 100;
export const BOOKING_HORIZON_DAYS = 180;

const DAY = 86400000;
const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const text = (max) => z.string().trim().min(1).max(max);
const consultationType = z.enum(CONSULTATION_TYPES);
const consultationTypes = z.array(consultationType).min(1).max(CONSULTATION_TYPES.length).transform((items) => [...new Set(items)]);
const emptyQuery = z.object({}).strict();
const idParams = z.object({ id: uuid }).strict();
const paging = { limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) };
// Meeting links are shown to patients as a button, so only real https links are accepted.
const meetingUrl = z.string().trim().max(500).url().refine((value) => value.startsWith('https://'), 'meetingUrl must be an https link');

const range = (maxDays) => z.object({ from: instant.optional(), to: instant.optional() }).strict().superRefine((q, ctx) => {
  if (q.from && q.to) {
    const span = new Date(q.to) - new Date(q.from);
    if (span <= 0 || span > maxDays * DAY) ctx.addIssue({ code: 'custom', path: ['to'], message: `Range must be positive and at most ${maxDays} days` });
  }
});

// ---------------- Patient ----------------
export const doctorSlots = z.object({ params: z.object({ doctorId: uuid }).strict(), query: range(31) });
export const book = z.object({
  query: emptyQuery,
  body: z.object({ slotId: uuid, consultationType, reason: text(500).optional(), dependentId: uuid.optional() }).strict(),
});
export const mine = z.object({
  query: z.object({ ...paging, status: z.enum(STATUSES).optional(), upcoming: z.enum(['true', 'false']).optional() }).strict(),
});
export const appointmentId = z.object({ params: idParams, query: emptyQuery });
export const patientCancel = z.object({ params: idParams, query: emptyQuery, body: z.object({ reason: text(300).optional() }).strict() });
export const reschedule = z.object({
  params: idParams,
  query: emptyQuery,
  body: z.object({ slotId: uuid, consultationType: consultationType.optional(), reason: text(500).optional() }).strict(),
});

// ---------------- Doctor workspace ----------------
export const practiceProfile = z.object({
  query: emptyQuery,
  body: z.object({
    practiceName: text(160).optional(),
    bio: text(2000).nullable().optional(),
    yearsOfExperience: z.number().int().min(0).max(70).nullable().optional(),
    consultationFeeMinor: z.number().int().min(0).max(100000000).nullable().optional(),
    consultationTypes: z.array(consultationType).max(CONSULTATION_TYPES.length).transform((items) => [...new Set(items)]).optional(),
    practiceAddress: text(300).nullable().optional(),
  }).strict().refine((body) => Object.keys(body).length > 0, 'No changes supplied'),
});

const slotInput = z.object({ startsAt: instant, endsAt: instant, consultationTypes }).strict().superRefine((slot, ctx) => {
  const start = new Date(slot.startsAt);
  const minutes = (new Date(slot.endsAt) - start) / 60000;
  if (minutes < SLOT_MINUTES.min || minutes > SLOT_MINUTES.max) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: `Slots must last ${SLOT_MINUTES.min}-${SLOT_MINUTES.max} minutes` });
  if (start <= new Date()) ctx.addIssue({ code: 'custom', path: ['startsAt'], message: 'Slots must start in the future' });
  if (start > new Date(Date.now() + BOOKING_HORIZON_DAYS * DAY)) ctx.addIssue({ code: 'custom', path: ['startsAt'], message: `Slots can be published up to ${BOOKING_HORIZON_DAYS} days ahead` });
});
export const createSlots = z.object({
  query: emptyQuery,
  body: z.object({ slots: z.array(slotInput).min(1).max(MAX_SLOTS_PER_REQUEST) }).strict().superRefine(({ slots }, ctx) => {
    const sorted = slots.map((s, i) => ({ ...s, i, a: new Date(s.startsAt), b: new Date(s.endsAt) })).sort((x, y) => x.a - y.a);
    for (let k = 1; k < sorted.length; k += 1) {
      if (sorted[k].a < sorted[k - 1].b) ctx.addIssue({ code: 'custom', path: ['slots', sorted[k].i], message: 'Slots in the same request overlap' });
    }
  }),
});
export const practiceSlots = z.object({ query: range(62) });
export const slotId = z.object({ params: idParams, query: emptyQuery });
export const practiceQueue = z.object({
  query: z.object({ ...paging, status: z.enum(STATUSES).optional(), from: instant.optional() }).strict(),
});
export const confirm = z.object({ params: idParams, query: emptyQuery, body: z.object({ meetingUrl: meetingUrl.optional() }).strict() });
export const meetingLink = z.object({ params: idParams, query: emptyQuery, body: z.object({ meetingUrl: meetingUrl.nullable() }).strict() });
export const decline = z.object({ params: idParams, query: emptyQuery, body: z.object({ reason: text(300) }).strict() });
export const doctorCancel = z.object({ params: idParams, query: emptyQuery, body: z.object({ reason: text(300) }).strict() });
export const complete = z.object({ params: idParams, query: emptyQuery, body: z.object({}).strict() });
