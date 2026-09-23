import { z } from 'zod';
const empty = z.object({}).strict();
const hospital = z.object({ hospitalId: z.uuid() }).strict();
const plan = hospital.extend({ planId: z.uuid() }).strict();
const fields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  feeMinor: z.number().int().min(0).max(2147483647),
}).strict();
const pagination = { limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0) };
const envelope = (params, body = empty.optional(), query = empty) => z.object({ params, body, query });
export const create = envelope(hospital, fields);
export const update = envelope(plan, fields.partial().refine((v) => Object.keys(v).length > 0, 'Provide at least one plan field'));
export const archive = envelope(plan);
export const detail = envelope(plan);
export const publicList = envelope(hospital, empty.optional(), z.object(pagination).strict());
export const ownerList = envelope(hospital, empty.optional(), z.object({ ...pagination, status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }).strict());
