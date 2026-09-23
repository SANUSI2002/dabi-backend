import { z } from 'zod';
const isoDateTime = z.string().datetime({ offset: true });
export const listHealthMetricsSchema = z.object({
  query: z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), from: isoDateTime.optional(), to: isoDateTime.optional(), minScore: z.coerce.number().int().min(0).max(100).optional(), maxScore: z.coerce.number().int().min(0).max(100).optional(), sort: z.enum(['asc', 'desc']).default('desc') }).strict(),
}).superRefine(({ query }, ctx) => { if (query.from && query.to && new Date(query.from) > new Date(query.to)) ctx.addIssue({ code: 'custom', path: ['query', 'to'], message: 'to must be after from' }); if (query.minScore !== undefined && query.maxScore !== undefined && query.minScore > query.maxScore) ctx.addIssue({ code: 'custom', path: ['query', 'maxScore'], message: 'maxScore must be at least minScore' }); });
