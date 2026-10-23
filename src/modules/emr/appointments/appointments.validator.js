import { z } from 'zod';

const org = { organizationId: z.uuid() };
const one = { ...org, appointmentId: z.uuid() };
const noQuery = z.object({}).strict();
const noBody = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
// The starter Appointment Types (Settings → Master Data); a hospital's own types are checked by the service.
export const APPOINTMENT_TYPES = ['GENERAL', 'ANC', 'PNC', 'FOLLOW_UP', 'IMMUNIZATION', 'SPECIALIST'];
const appointmentType = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,19}$/, 'An appointment type code');
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
    type: appointmentType.default('GENERAL'),
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

// Patient-app requests (appointment-requests.service.js).
const REQUEST_STATUSES = ['PENDING', 'SCHEDULED', 'REJECTED', 'CHECKED_IN', 'CANCELLED'];
const oneRequest = { ...org, requestId: z.uuid() };
export const listRequests = z.object({
  params: z.object(org).strict(),
  query: z.object({
    status: z.string().transform((value) => value.split(',')).pipe(z.array(z.enum(REQUEST_STATUSES)).min(1)).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().max(200).optional(),
  }).strict(),
});
export const confirmRequest = z.object({
  params: z.object(oneRequest).strict(),
  query: noQuery,
  body: z.object({
    // The record the visit is for; needed when the requester has no linked record, or the visit is a dependent's.
    patientId: z.uuid().optional(),
    // Defaults to the type closest to what the patient picked in the app.
    type: appointmentType.optional(),
    providerUserId: z.uuid().optional(),
  }).strict(),
});
export const rejectRequest = z.object({
  params: z.object(oneRequest).strict(),
  query: noQuery,
  body: cancel.shape.body, // the reason, as for a cancellation
});
