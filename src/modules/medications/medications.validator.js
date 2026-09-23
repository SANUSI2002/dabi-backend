import { z } from 'zod';

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM');
const pageQuery = { page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };
const medicationBody = { name: z.string().trim().min(1).max(120), instructions: z.string().trim().max(500).nullable().optional(), time: clockTime };
export const medicationIdSchema = z.object({ params: z.object({ id: z.string().uuid() }).strict() });
export const listMedicationsSchema = z.object({ query: z.object({ ...pageQuery, adherence: z.enum(['all', 'taken', 'pending']).default('all'), search: z.string().trim().min(1).max(80).optional(), sort: z.enum(['asc', 'desc']).default('asc') }).strict() });
export const createMedicationSchema = z.object({ body: z.object(medicationBody).strict() });
export const updateMedicationSchema = z.object({ params: z.object({ id: z.string().uuid() }).strict(), body: z.object({ name: medicationBody.name.optional(), instructions: medicationBody.instructions, time: clockTime.optional() }).strict() }).refine(({ body }) => Object.keys(body).length > 0, { path: ['body'], message: 'At least one update field is required' });
export const adherenceSchema = z.object({ params: z.object({ id: z.string().uuid() }).strict(), body: z.object({ isTaken: z.boolean() }).strict() });
