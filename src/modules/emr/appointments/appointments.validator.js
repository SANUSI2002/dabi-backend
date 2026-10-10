import { z } from 'zod';

const org = { organizationId: z.uuid() };
const one = { ...org, appointmentId: z.uuid() };
const noQuery = z.object({}).strict();
const noBody = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
export const APPOINTMENT_TYPES = ['GENERAL', 'ANC', 'PNC', 'FOLLOW_UP', 'IMMUNIZATION', 'SPECIALIST'];
const STATUSES = ['SCHEDULED', 'ATTENDED', 'NO_SHOW', 'CANCELLED'];
const instant = z.iso.datetime({ offset: true });

export const list = z.object({
  params: z.object(org).strict(),
  query: z.object({
    from: instant.optional(),
    to: instant.optional(),
    status: z.string().transform((value) => value.split(',')).pipe(z.array(z.enum(STATUSES)).min(1)).optional(),
    patientId: z.uuid().optional(),
    providerUserId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().max(200).optional(),
  }).strict(),
});

export const book = z.object({
  params: z.object(org).strict(),
  query: noQuery,
  body: z.object({
    patientId: z.uuid(),
    // Local date and time with the hospital's offset, e.g. 2026-10-12T09:30:00+01:00.
    scheduledAt: instant.refine((value) => new Date(value).getTime() < Date.now() + 400 * 86_400_000, 'Book within the next year'),
    type: z.enum(APPOINTMENT_TYPES).default('GENERAL'),
    providerUserId: z.uuid().optional(),
    reason: text(300).optional(),
  }).strict(),
});

export const transition = z.object({ params: z.object(one).strict(), query: noQuery, body: noBody });
export const cancel = z.object({
  params: z.object(one).strict(),
  query: noQuery,
  body: z.object({ reason: z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters') }).strict(),
});
