import { z } from 'zod';

const appointmentTypes = z.enum(['IN_PERSON', 'VIRTUAL']);
const appointmentStatuses = z.enum(['SCHEDULED', 'CANCELLED', 'COMPLETED']);
const isoDateTime = z.string().datetime({ offset: true });
const pageQuery = { page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };

export const appointmentIdSchema = z.object({ params: z.object({ id: z.string().uuid() }).strict() });
export const listAppointmentsSchema = z.object({
  query: z.object({ ...pageQuery, status: appointmentStatuses.optional(), type: appointmentTypes.optional(), from: isoDateTime.optional(), to: isoDateTime.optional(), sort: z.enum(['asc', 'desc']).default('asc') }).strict(),
}).superRefine(({ query }, ctx) => { if (query.from && query.to && new Date(query.from) > new Date(query.to)) ctx.addIssue({ code: 'custom', path: ['query', 'to'], message: 'to must be after from' }); });
export const createAppointmentSchema = z.object({ body: z.object({ title: z.string().trim().min(2).max(120), doctorName: z.string().trim().min(2).max(120).optional(), time: isoDateTime, type: appointmentTypes }).strict() });
export const updateAppointmentSchema = z.object({
  params: z.object({ id: z.string().uuid() }).strict(),
  body: z.object({ title: z.string().trim().min(2).max(120).optional(), doctorName: z.string().trim().min(2).max(120).nullable().optional(), time: isoDateTime.optional(), type: appointmentTypes.optional() }).strict(),
}).refine(({ body }) => Object.keys(body).length > 0, { path: ['body'], message: 'At least one update field is required' });
