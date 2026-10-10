import { z } from 'zod';

const org = { organizationId: z.uuid() };
const one = { ...org, procedureId: z.uuid() };
const noQuery = z.object({}).strict();
const noBody = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
// Clinical prose may span lines.
const prose = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const STATUSES = ['REQUESTED', 'SCHEDULED', 'CONSENTED', 'PRE_PROCEDURE', 'PERFORMED', 'RECOVERY', 'FOLLOW_UP', 'CANCELLED'];
const change = (body) => z.object({ params: z.object(one).strict(), query: noQuery, body: body.strict() });

export const list = z.object({
  params: z.object(org).strict(),
  query: z.object({
    status: z.string().transform((value) => value.split(',')).pipe(z.array(z.enum(STATUSES)).min(1)).optional(),
    patientId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().max(200).optional(),
  }).strict(),
});

export const request = z.object({
  params: z.object(org).strict(),
  query: noQuery,
  body: z.object({
    patientId: z.uuid(),
    encounterId: z.uuid().optional(),
    name: text(120),
    indication: prose(1000),
    bodySite: text(120).optional(),
    laterality: z.enum(['LEFT', 'RIGHT', 'BILATERAL']).optional(),
    priority: z.enum(['ROUTINE', 'URGENT', 'EMERGENCY']).default('ROUTINE'),
  }).strict(),
});

export const schedule = change(z.object({
  scheduledFor: z.iso.date().refine((d) => new Date(`${d}T00:00:00.000Z`).getTime() >= Date.now() - 2 * 86_400_000, 'The date has passed'),
  performerUserId: z.uuid(),
  assistantUserIds: z.array(z.uuid()).max(6).refine((ids) => new Set(ids).size === ids.length, 'Each assistant once').default([]),
}));
export const consent = change(z.object({ obtainedByUserId: z.uuid() }));
export const checklistItem = z.object({
  params: z.object({ ...one, itemId: z.uuid() }).strict(),
  query: noQuery,
  body: z.object({ completed: z.boolean(), exceptionReason: text(200).optional() }).strict()
    .refine((body) => body.completed || body.exceptionReason === undefined || body.exceptionReason.length > 0, 'Give the reason'),
});
export const transition = change(noBody);
export const perform = change(z.object({
  anaesthesia: text(120).optional(),
  device: text(120).optional(),
  complications: prose(1000).optional(),
  outcome: prose(2000),
  findings: prose(2000).optional(),
  specimenSentToLab: z.boolean().default(false),
}));
export const recovery = change(z.object({ recoveryNotes: prose(2000) }));
export const followUp = change(z.object({ followUpPlan: prose(2000) }));
export const amend = change(z.object({ note: prose(2000) }));
export const cancel = change(z.object({ reason: z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters') }));
