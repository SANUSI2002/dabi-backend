import { z } from 'zod';
const instant = z.string().datetime({ offset: true });
const scope = { circlePatientId: z.string().uuid().optional(), memberId: z.union([z.literal('self'), z.string().uuid()]).optional() };
export const calendar = z.object({ query: z.object({ ...scope, from: instant, to: instant }).strict() }).superRefine(({ query }, ctx) => {
  const duration = new Date(query.to) - new Date(query.from);
  if (duration <= 0 || duration > 43 * 86400000) ctx.addIssue({ code: 'custom', path: ['query', 'to'], message: 'Range must be positive and at most 43 elapsed days' });
});
export const upcoming = z.object({ query: z.object({ ...scope, from: instant,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict() });
