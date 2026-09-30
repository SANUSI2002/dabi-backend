import { z } from 'zod';
import { analytesSchema } from './lab.catalog.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const noBody = z.object({}).strict();
const reason = z.string().trim().min(3).max(500).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const testCode = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,23}$/, 'Test codes are letters, digits and _');
const orderParams = z.object({ ...org, orderId: z.uuid() }).strict();
const itemParams = z.object({ ...org, orderId: z.uuid(), itemId: z.uuid() }).strict();
const resultEntries = z.array(z.object({
  analyteCode: z.string().trim().toUpperCase().max(24),
  value: z.union([z.number().finite(), z.string().max(2000)]),
}).strict()).min(1).max(40);

// ---- catalog ----
// The lab section a test is grouped under on ordering screens (e.g. Haematology).
const section = z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
export const listTests = z.object({ params: z.object(org).strict(), query: z.object({ includeInactive: z.enum(['true', 'false']).optional() }).strict() });
export const createTest = z.object({
  params: z.object(org).strict(), query: noQuery,
  body: z.object({ code: testCode, name: z.string().trim().min(1).max(120), section: section.optional(), specimenType: z.string().trim().min(1).max(80), analytes: analytesSchema }).strict(),
});
export const updateTest = z.object({
  params: z.object({ ...org, code: testCode }).strict(), query: noQuery,
  body: z.object({ name: z.string().trim().min(1).max(120).optional(), section: section.optional(), specimenType: z.string().trim().min(1).max(80).optional(), analytes: analytesSchema.optional(), active: z.boolean().optional() })
    .strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});

// ---- orders ----
export const orderTests = z.object({
  params: z.object({ ...org, encounterId: z.uuid() }).strict(), query: noQuery,
  body: z.object({
    tests: z.array(testCode).min(1).max(20).refine((codes) => new Set(codes).size === codes.length, 'Each test can be ordered once per order'),
    priority: z.enum(['ROUTINE', 'URGENT', 'STAT']).default('ROUTINE'),
    clinicalNotes: z.string().trim().max(1000).optional(),
  }).strict(),
});
export const encounterOrders = z.object({ params: z.object({ ...org, encounterId: z.uuid() }).strict(), query: noQuery });

export const worklist = z.object({
  params: z.object(org).strict(),
  query: z.object({
    status: z.string().optional().transform((value) => (value ? value.split(',') : undefined))
      .pipe(z.array(z.enum(['ORDERED', 'COLLECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])).max(5).optional()),
    priority: z.enum(['ROUTINE', 'URGENT', 'STAT']).optional(),
    patientId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(200).optional(),
  }).strict(),
});
export const oneOrder = z.object({ params: orderParams, query: noQuery });
export const collect = z.object({ params: orderParams, query: noQuery, body: z.object({ note: z.string().trim().max(500).optional() }).strict() });
export const cancel = z.object({ params: orderParams, query: noQuery, body: z.object({ reason }).strict() });

// ---- results ----
export const enterResults = z.object({ params: itemParams, query: noQuery, body: z.object({ results: resultEntries }).strict() });
export const verify = z.object({ params: itemParams, query: noQuery, body: noBody });
export const amend = z.object({ params: itemParams, query: noQuery, body: z.object({ reason, results: resultEntries }).strict() });
