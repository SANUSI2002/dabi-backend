import { z } from 'zod';
import { MODALITIES } from './radiology.service.js';

const org = { organizationId: z.uuid() };
const one = { ...org, studyId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
// Report text may span lines.
const prose = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const STATUSES = ['REQUESTED', 'SCHEDULED', 'PERFORMED', 'REPORTED', 'VERIFIED', 'AMENDED', 'CANCELLED'];

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
    modality: z.enum(MODALITIES),
    bodySite: text(120),
    laterality: z.enum(['LEFT', 'RIGHT', 'BILATERAL']).optional(),
    indication: prose(500),
    priority: z.enum(['ROUTINE', 'URGENT', 'EMERGENCY']).default('ROUTINE'),
    preparation: text(200).optional(),
    externalStudy: z.boolean().default(false),
  }).strict(),
});

export const schedule = z.object({
  params: z.object(one).strict(), query: noQuery,
  body: z.object({
    scheduledFor: z.iso.date().refine((d) => new Date(`${d}T00:00:00.000Z`).getTime() >= Date.now() - 2 * 86_400_000, 'The date has passed'),
  }).strict(),
});

export const perform = z.object({
  params: z.object(one).strict(), query: noQuery,
  body: z.object({
    series: z.array(z.object({ description: text(120), bodyPart: text(120).optional(), imageCount: z.number().int().min(1).max(10_000).optional() }).strict()).min(1).max(20),
  }).strict(),
});

export const report = z.object({ params: z.object(one).strict(), query: noQuery, body: z.object({ findings: prose(5000), impression: prose(1000) }).strict() });
export const verify = z.object({ params: z.object(one).strict(), query: noQuery, body: z.object({}).strict() });
export const addendum = z.object({ params: z.object(one).strict(), query: noQuery, body: z.object({ note: prose(2000) }).strict() });
export const cancel = z.object({ params: z.object(one).strict(), query: noQuery, body: z.object({ reason: z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters') }).strict() });
export const comparison = z.object({ params: z.object(one).strict(), query: noQuery, body: z.object({ compareToStudyId: z.uuid().nullable() }).strict() });
